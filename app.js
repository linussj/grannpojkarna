const appConfig = window.GRANNPOJKARNA_CONFIG || {};
const hasBackendConfig = Boolean(appConfig.supabaseUrl && appConfig.supabasePublishableKey);
const supabaseClient = hasBackendConfig && window.supabase
  ? window.supabase.createClient(appConfig.supabaseUrl, appConfig.supabasePublishableKey)
  : null;

let currentUser = null;
let currentProfile = null;
let pendingJob = false;
let pendingApplicationJobId = null;
let selectedApplicationJobId = null;
let roleHint = document.body.dataset.page === "jobs" ? "performer" : "customer";
let publicJobs = [];

const byId = (id) => document.getElementById(id);

function setNotice(id, message = "", type = "") {
  const element = byId(id);
  if (!element) return;
  element.textContent = message;
  element.className = `notice${type ? ` ${type}` : ""}${message ? "" : " hidden"}`;
}

function setLoading(buttonId, isLoading, loadingText, defaultText) {
  const button = byId(buttonId);
  if (!button) return;
  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : defaultText;
}

function hideAccountSteps() {
  ["authEmailStep", "authCodeStep", "profileStep", "performerStep", "accountStep"].forEach((id) => {
    byId(id)?.classList.add("hidden");
  });
}

function showEmailStep() {
  hideAccountSteps();
  byId("authEmailStep")?.classList.remove("hidden");
  if (byId("accountTitle")) byId("accountTitle").textContent = "Logga in eller skapa konto";
  setNotice("authEmailNotice");
}

function showCodeStep(email) {
  hideAccountSteps();
  byId("authCodeStep")?.classList.remove("hidden");
  if (byId("codeEmail")) byId("codeEmail").textContent = email;
  if (byId("accountTitle")) byId("accountTitle").textContent = "Ange din kod";
  byId("authCode")?.focus();
}

function showProfileStep() {
  hideAccountSteps();
  byId("profileStep")?.classList.remove("hidden");
  if (byId("accountTitle")) byId("accountTitle").textContent = "Skapa din profil";
  const preferredUse = roleHint === "performer" ? "performer" : "customer";
  const option = document.querySelector(`input[name="profileUse"][value="${preferredUse}"]`);
  if (option) option.checked = true;
}

function showPerformerStep() {
  if (!currentUser || !currentProfile) {
    roleHint = "performer";
    openAccountModal("performer");
    return;
  }
  hideAccountSteps();
  byId("performerStep")?.classList.remove("hidden");
  if (byId("accountTitle")) byId("accountTitle").textContent = "Din utförarprofil";
  if (byId("performerArea")) byId("performerArea").value = currentProfile.service_area || "";
  if (byId("performerSkills")) byId("performerSkills").value = (currentProfile.skills || []).join(", ");
  if (byId("performerBio")) byId("performerBio").value = currentProfile.bio || "";
  setNotice("performerNotice");
}

async function showAccountStep() {
  hideAccountSteps();
  byId("accountStep")?.classList.remove("hidden");
  if (byId("accountTitle")) byId("accountTitle").textContent = "Mitt konto";
  if (byId("accountName")) byId("accountName").textContent = currentProfile?.display_name || "Mitt konto";
  if (byId("accountEmail")) byId("accountEmail").textContent = currentUser?.email || "";
  const accountType = currentProfile?.account_type === "company" ? "Företag" : "Privatperson";
  const capability = currentProfile?.performer_enabled ? "Beställare + utförare" : "Beställare";
  if (byId("accountRole")) byId("accountRole").textContent = `${accountType} · ${capability}`;
  byId("findJobsBtn")?.classList.toggle("hidden", !currentProfile?.performer_enabled);
  byId("enablePerformerBtn")?.classList.toggle("hidden", Boolean(currentProfile?.performer_enabled));
  await loadMyJobs();
}

function openAccountModal(preselectedRole = "customer") {
  roleHint = preselectedRole;
  byId("accountModal")?.classList.add("show");
  if (!hasBackendConfig) {
    showEmailStep();
    setNotice("authEmailNotice", "Kontosystemet är ännu inte anslutet till databasen.", "error");
    return;
  }
  if (currentUser && currentProfile) {
    if (preselectedRole === "performer" && !currentProfile.performer_enabled) showPerformerStep();
    else showAccountStep();
  } else if (currentUser) {
    showProfileStep();
  } else {
    showEmailStep();
    setTimeout(() => byId("authEmail")?.focus(), 50);
  }
}

function closeAccountModal() {
  byId("accountModal")?.classList.remove("show");
}

async function sendLoginCode() {
  const email = byId("authEmail")?.value.trim().toLowerCase() || "";
  if (!email || !email.includes("@")) {
    setNotice("authEmailNotice", "Ange en giltig mejladress.", "error");
    return;
  }
  if (!supabaseClient) {
    setNotice("authEmailNotice", "Databasen är ännu inte ansluten.", "error");
    return;
  }
  setLoading("sendCodeBtn", true, "Skickar…", "Skicka kod");
  setNotice("authEmailNotice");
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true }
  });
  setLoading("sendCodeBtn", false, "Skickar…", "Skicka kod");
  if (error) {
    setNotice("authEmailNotice", "Koden kunde inte skickas. Försök igen om en stund.", "error");
    return;
  }
  showCodeStep(email);
}

async function verifyLoginCode() {
  const email = byId("authEmail")?.value.trim().toLowerCase() || "";
  const token = byId("authCode")?.value.trim() || "";
  if (!/^\d{6}$/.test(token)) {
    setNotice("authCodeNotice", "Koden ska bestå av sex siffror.", "error");
    return;
  }
  setLoading("verifyCodeBtn", true, "Verifierar…", "Verifiera och fortsätt");
  setNotice("authCodeNotice");
  const { data, error } = await supabaseClient.auth.verifyOtp({ email, token, type: "email" });
  setLoading("verifyCodeBtn", false, "Verifierar…", "Verifiera och fortsätt");
  if (error || !data.user) {
    setNotice("authCodeNotice", "Koden är felaktig eller har gått ut.", "error");
    return;
  }
  currentUser = data.user;
  await loadProfile();
  if (!currentProfile) {
    showProfileStep();
    return;
  }
  if (pendingApplicationJobId && !currentProfile.performer_enabled) showPerformerStep();
  else {
    await showAccountStep();
    continuePendingAction();
  }
}

async function loadProfile() {
  if (!supabaseClient || !currentUser) return null;
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, display_name, phone, account_type, performer_enabled, bio, service_area, skills, role")
    .eq("id", currentUser.id)
    .maybeSingle();
  if (error) {
    setNotice("accountNotice", "Profilen kunde inte hämtas. Databasuppdateringen kan saknas.", "error");
    currentProfile = null;
    return null;
  }
  currentProfile = data;
  updateAccountButton();
  return data;
}

async function saveProfile() {
  const displayName = byId("profileName")?.value.trim() || "";
  const phone = byId("profilePhone")?.value.trim() || "";
  const accountType = byId("profileAccountType")?.value || "private";
  const use = document.querySelector('input[name="profileUse"]:checked')?.value || "customer";
  const performerEnabled = use === "performer" || use === "both";
  if (displayName.length < 2) {
    setNotice("profileNotice", "Ange ditt namn.", "error");
    return;
  }
  setLoading("saveProfileBtn", true, "Sparar…", "Skapa konto");
  const { data, error } = await supabaseClient
    .from("profiles")
    .upsert({
      id: currentUser.id,
      display_name: displayName,
      phone: phone || null,
      account_type: accountType,
      performer_enabled: performerEnabled,
      role: accountType === "company" ? "company" : performerEnabled ? "helper" : "customer"
    })
    .select("id, display_name, phone, account_type, performer_enabled, bio, service_area, skills, role")
    .single();
  setLoading("saveProfileBtn", false, "Sparar…", "Skapa konto");
  if (error) {
    setNotice("profileNotice", "Profilen kunde inte sparas. Kontrollera att databasuppdateringen är körd.", "error");
    return;
  }
  currentProfile = data;
  updateAccountButton();
  if (performerEnabled && (!currentProfile.service_area || pendingApplicationJobId)) showPerformerStep();
  else {
    await showAccountStep();
    continuePendingAction();
  }
}

async function savePerformerProfile() {
  const serviceArea = byId("performerArea")?.value.trim() || "";
  const skills = (byId("performerSkills")?.value || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 12);
  const bio = byId("performerBio")?.value.trim() || "";
  if (serviceArea.length < 2 || !skills.length) {
    setNotice("performerNotice", "Ange område och minst en sak du kan hjälpa till med.", "error");
    return;
  }
  setLoading("savePerformerBtn", true, "Sparar…", "Aktivera utförarprofil");
  const { data, error } = await supabaseClient
    .from("profiles")
    .update({ performer_enabled: true, service_area: serviceArea, skills, bio: bio || null })
    .eq("id", currentUser.id)
    .select("id, display_name, phone, account_type, performer_enabled, bio, service_area, skills, role")
    .single();
  setLoading("savePerformerBtn", false, "Sparar…", "Aktivera utförarprofil");
  if (error) {
    setNotice("performerNotice", "Utförarprofilen kunde inte sparas.", "error");
    return;
  }
  currentProfile = data;
  updateAccountButton();
  await showAccountStep();
  continuePendingAction();
}

function updateAccountButton() {
  if (byId("accountBtn")) byId("accountBtn").textContent = currentUser ? "Mitt konto" : "Logga in";
}

function openModal(type) {
  if (type === "helper") {
    window.location.href = "jobb.html";
    return;
  }
  if (!byId("modal")) {
    window.location.href = "index.html?newJob=1";
    return;
  }
  if (!currentUser || !currentProfile) {
    pendingJob = true;
    openAccountModal("customer");
    return;
  }
  byId("modal").classList.add("show");
  setNotice("jobNotice");
}

function closeModal() {
  byId("modal")?.classList.remove("show");
}

function continuePendingAction() {
  if (pendingApplicationJobId && currentProfile?.performer_enabled) {
    const jobId = pendingApplicationJobId;
    pendingApplicationJobId = null;
    closeAccountModal();
    setTimeout(() => openApplicationModal(jobId), 120);
    return;
  }
  if (pendingJob && currentProfile) {
    pendingJob = false;
    closeAccountModal();
    setTimeout(() => openModal("job"), 120);
  }
}

function openJobFromAccount() {
  closeAccountModal();
  setTimeout(() => openModal("job"), 120);
}

function parseBudget(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

async function submitJob(event) {
  event.preventDefault();
  if (!currentUser || !currentProfile) {
    closeModal();
    pendingJob = true;
    openAccountModal("customer");
    return;
  }
  const payload = {
    user_id: currentUser.id,
    title: byId("jobTitle").value.trim(),
    description: byId("description").value.trim(),
    location: byId("jobLocation").value.trim(),
    timing: byId("jobWhen").value,
    budget_sek: parseBudget(byId("jobBudget").value),
    price_type: byId("jobPriceType").value,
    category: byId("jobCategory").value
  };
  if (payload.title.length < 4 || payload.description.length < 10 || !payload.location || !payload.budget_sek) {
    setNotice("jobNotice", "Fyll i rubrik, beskrivning, plats och budget.", "error");
    return;
  }
  setLoading("submitBtn", true, "Publicerar…", "Publicera jobb");
  const { error } = await supabaseClient.from("jobs").insert(payload);
  setLoading("submitBtn", false, "Publicerar…", "Publicera jobb");
  if (error) {
    setNotice("jobNotice", "Jobbet kunde inte publiceras. Kontrollera att databasuppdateringen är körd.", "error");
    return;
  }
  byId("jobForm").reset();
  setNotice("jobNotice", "Jobbet är publicerat! Du skickas till jobblistan.", "success");
  setTimeout(() => { window.location.href = "jobb.html"; }, 900);
}

async function loadMyJobs() {
  const container = byId("myJobs");
  if (!container || !supabaseClient || !currentUser) return;
  container.innerHTML = '<div class="account-meta">Hämtar dina publicerade jobb…</div>';
  const { data, error } = await supabaseClient
    .from("jobs")
    .select("id, title, description, location, timing, budget_sek, price_type, category, status, created_at")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });
  if (error) {
    container.innerHTML = '<div class="notice error">Jobben kunde inte hämtas.</div>';
    return;
  }
  if (!data.length) {
    container.innerHTML = '<div class="notice">Du har inte lagt upp något jobb ännu.</div>';
    return;
  }
  container.innerHTML = data.map((job) => `
    <article class="job-row">
      <div class="job-row-top">
        <div>
          <h4>${escapeHtml(job.title || job.category)}</h4>
          <div class="account-meta">${escapeHtml(job.location)} · ${escapeHtml(job.timing)}</div>
        </div>
        <span class="status-pill">${statusLabel(job.status)}</span>
      </div>
      <p>${escapeHtml(job.description)}</p>
      <strong>${formatPrice(job)}</strong>
    </article>
  `).join("");
}

function openCallbackModal() {
  byId("callbackModal")?.classList.add("show");
  setNotice("callbackNotice");
  setTimeout(() => byId("callbackName")?.focus(), 50);
}

function closeCallbackModal() {
  byId("callbackModal")?.classList.remove("show");
}

async function submitCallbackRequest(event) {
  event.preventDefault();
  if (byId("callbackWebsite")?.value) return;
  const name = byId("callbackName").value.trim();
  const phone = byId("callbackPhone").value.trim();
  const preferredTime = byId("callbackTime").value;
  const description = byId("callbackDescription").value.trim();
  const phoneDigits = phone.replace(/\D/g, "");
  if (name.length < 2 || phoneDigits.length < 7 || phoneDigits.length > 15 || description.length < 5) {
    setNotice("callbackNotice", "Kontrollera namn, telefonnummer och beskrivning.", "error");
    return;
  }
  if (!supabaseClient) {
    setNotice("callbackNotice", "Förfrågan kunde inte skickas just nu.", "error");
    return;
  }
  setLoading("callbackSubmitBtn", true, "Skickar…", "Skicka förfrågan");
  const { error } = await supabaseClient.from("callback_requests").insert({
    name,
    phone,
    preferred_time: preferredTime,
    description,
    consent: true
  });
  setLoading("callbackSubmitBtn", false, "Skickar…", "Skicka förfrågan");
  if (error) {
    setNotice("callbackNotice", "Förfrågan kunde inte skickas. Kontrollera att databasuppdateringen är körd.", "error");
    return;
  }
  byId("callbackForm").reset();
  setNotice("callbackNotice", "Tack! Din förfrågan är registrerad och vi återkommer per telefon.", "success");
}

async function loadPublicJobs() {
  if (!byId("publicJobs")) return;
  if (!supabaseClient) {
    renderJobsError("Jobblistan är inte ansluten ännu.");
    return;
  }
  const { data, error } = await supabaseClient
    .from("jobs")
    .select("id, user_id, title, description, location, timing, budget_sek, price_type, category, status, created_at")
    .eq("status", "open")
    .order("created_at", { ascending: false });
  if (error) {
    renderJobsError("Jobben kunde inte hämtas. Databasuppdateringen kan saknas.");
    return;
  }
  publicJobs = data || [];
  applyJobFilters();
}

function applyJobFilters() {
  if (!byId("publicJobs")) return;
  const search = (byId("filterSearch")?.value || "").trim().toLowerCase();
  const category = byId("filterCategory")?.value || "";
  const location = (byId("filterLocation")?.value || "").trim().toLowerCase();
  const timing = byId("filterTiming")?.value || "";
  const minBudget = Number(byId("filterMinBudget")?.value || 0);
  const sort = byId("filterSort")?.value || "newest";
  const filtered = publicJobs.filter((job) => {
    const searchable = `${job.title || ""} ${job.description || ""} ${job.category || ""}`.toLowerCase();
    return (!search || searchable.includes(search))
      && (!category || job.category === category)
      && (!location || String(job.location || "").toLowerCase().includes(location))
      && (!timing || job.timing === timing)
      && (!minBudget || Number(job.budget_sek) >= minBudget);
  });
  filtered.sort((a, b) => {
    if (sort === "highest") return Number(b.budget_sek) - Number(a.budget_sek);
    if (sort === "lowest") return Number(a.budget_sek) - Number(b.budget_sek);
    return new Date(b.created_at) - new Date(a.created_at);
  });
  renderPublicJobs(filtered);
}

function renderPublicJobs(jobs) {
  const container = byId("publicJobs");
  if (!container) return;
  if (byId("jobsCount")) byId("jobsCount").textContent = `${jobs.length} ${jobs.length === 1 ? "öppet jobb" : "öppna jobb"}`;
  if (!jobs.length) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>Inga jobb matchar filtret</h2>
        <p>Prova att rensa något filter eller kom tillbaka snart när fler jobb har lagts upp.</p>
        <button class="btn btn-light" onclick="resetJobFilters()">Rensa filter</button>
      </div>`;
    return;
  }
  container.innerHTML = jobs.map((job) => {
    const isOwnJob = currentUser?.id === job.user_id;
    return `
      <article class="feed-card">
        <div class="feed-card-top">
          <div>
            <span class="eyebrow">${escapeHtml(job.category)}</span>
            <h2>${escapeHtml(job.title || job.category)}</h2>
            <div class="meta">
              <span>📍 ${escapeHtml(job.location)}</span>
              <span>🗓 ${escapeHtml(job.timing)}</span>
              <span>${formatRelativeDate(job.created_at)}</span>
            </div>
          </div>
          <div class="feed-price">${formatPrice(job)}</div>
        </div>
        <p>${escapeHtml(job.description)}</p>
        <div class="feed-card-footer">
          <span class="account-meta">${job.price_type === "hourly" ? "Ersättning per timme" : job.price_type === "quote" ? "Beställaren är öppen för prisförslag" : "Fast ersättning"}</span>
          <button class="btn ${isOwnJob ? "btn-light" : "btn-primary"} btn-small" ${isOwnJob ? "disabled" : ""} onclick="beginApplication(${job.id})">
            ${isOwnJob ? "Ditt jobb" : "Anmäl intresse"}
          </button>
        </div>
      </article>`;
  }).join("");
}

function renderJobsError(message) {
  if (byId("jobsCount")) byId("jobsCount").textContent = "Jobblistan kunde inte laddas";
  if (byId("publicJobs")) byId("publicJobs").innerHTML = `<div class="notice error">${escapeHtml(message)}</div>`;
}

function resetJobFilters() {
  ["filterSearch", "filterCategory", "filterLocation", "filterTiming", "filterMinBudget"].forEach((id) => {
    if (byId(id)) byId(id).value = "";
  });
  if (byId("filterSort")) byId("filterSort").value = "newest";
  applyJobFilters();
}

function toggleJobFilters() {
  byId("jobFilters")?.classList.toggle("show");
}

function beginApplication(jobId) {
  const job = publicJobs.find((item) => Number(item.id) === Number(jobId));
  if (!job || currentUser?.id === job.user_id) return;
  if (!currentUser || !currentProfile) {
    pendingApplicationJobId = jobId;
    openAccountModal("performer");
    return;
  }
  if (!currentProfile.performer_enabled) {
    pendingApplicationJobId = jobId;
    byId("accountModal")?.classList.add("show");
    showPerformerStep();
    return;
  }
  openApplicationModal(jobId);
}

function openApplicationModal(jobId) {
  const job = publicJobs.find((item) => Number(item.id) === Number(jobId));
  if (!job) return;
  selectedApplicationJobId = jobId;
  if (byId("applicationJobTitle")) byId("applicationJobTitle").textContent = job.title || job.category;
  setNotice("applicationNotice");
  byId("applicationModal")?.classList.add("show");
  setTimeout(() => byId("applicationMessage")?.focus(), 50);
}

function closeApplicationModal() {
  selectedApplicationJobId = null;
  byId("applicationModal")?.classList.remove("show");
}

async function submitApplication(event) {
  event.preventDefault();
  if (!selectedApplicationJobId || !currentUser || !currentProfile?.performer_enabled) return;
  const message = byId("applicationMessage").value.trim();
  const proposedPrice = parseBudget(byId("applicationPrice").value);
  if (message.length < 10) {
    setNotice("applicationNotice", "Skriv ett lite längre meddelande till beställaren.", "error");
    return;
  }
  setLoading("applicationSubmitBtn", true, "Skickar…", "Skicka intresseanmälan");
  const { error } = await supabaseClient.from("job_applications").insert({
    job_id: selectedApplicationJobId,
    performer_id: currentUser.id,
    message,
    proposed_price_sek: proposedPrice
  });
  setLoading("applicationSubmitBtn", false, "Skickar…", "Skicka intresseanmälan");
  if (error) {
    const duplicate = error.code === "23505";
    setNotice("applicationNotice", duplicate ? "Du har redan anmält intresse för det här jobbet." : "Intresseanmälan kunde inte skickas.", "error");
    return;
  }
  byId("applicationForm").reset();
  setNotice("applicationNotice", "Din intresseanmälan är skickad!", "success");
}

function formatPrice(job) {
  const amount = Number(job.budget_sek || 0).toLocaleString("sv-SE");
  if (job.price_type === "hourly") return `${amount} kr/tim`;
  if (job.price_type === "quote") return `Ca ${amount} kr`;
  return `${amount} kr`;
}

function formatRelativeDate(value) {
  const diffHours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3600000));
  if (diffHours < 1) return "Nyss";
  if (diffHours < 24) return `${diffHours} tim sedan`;
  const days = Math.floor(diffHours / 24);
  return `${days} ${days === 1 ? "dag" : "dagar"} sedan`;
}

function statusLabel(status) {
  return ({ open: "Öppet", matched: "Matchat", completed: "Klart", cancelled: "Avbrutet" })[status] || escapeHtml(status);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function signOut() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  updateAccountButton();
  closeAccountModal();
  if (byId("publicJobs")) renderPublicJobs(publicJobs);
}

async function initializeAuth() {
  if (supabaseClient) {
    const { data } = await supabaseClient.auth.getSession();
    currentUser = data.session?.user || null;
    if (currentUser) await loadProfile();
    updateAccountButton();
    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
      currentUser = session?.user || null;
      if (currentUser) await loadProfile();
      else currentProfile = null;
      updateAccountButton();
      if (byId("publicJobs")) renderPublicJobs(publicJobs);
    });
  }
  if (byId("publicJobs")) await loadPublicJobs();
  const params = new URLSearchParams(window.location.search);
  if (params.get("newJob") === "1") {
    pendingJob = true;
    openModal("job");
  }
}

function attachPageEvents() {
  byId("modal")?.addEventListener("click", function (event) { if (event.target === this) closeModal(); });
  byId("accountModal")?.addEventListener("click", function (event) { if (event.target === this) closeAccountModal(); });
  byId("callbackModal")?.addEventListener("click", function (event) { if (event.target === this) closeCallbackModal(); });
  byId("applicationModal")?.addEventListener("click", function (event) { if (event.target === this) closeApplicationModal(); });
  byId("authEmail")?.addEventListener("keydown", (event) => { if (event.key === "Enter") sendLoginCode(); });
  byId("authCode")?.addEventListener("keydown", (event) => { if (event.key === "Enter") verifyLoginCode(); });
  ["filterSearch", "filterCategory", "filterLocation", "filterTiming", "filterMinBudget", "filterSort"].forEach((id) => {
    const element = byId(id);
    if (!element) return;
    const eventName = ["filterSearch", "filterLocation", "filterMinBudget"].includes(id) ? "input" : "change";
    element.addEventListener(eventName, applyJobFilters);
  });
}

attachPageEvents();
initializeAuth();
