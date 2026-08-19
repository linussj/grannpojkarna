const appConfig = window.GRANNPOJKARNA_CONFIG || {};
const hasBackendConfig = Boolean(
  appConfig.supabaseUrl && appConfig.supabasePublishableKey
);

const supabaseClient = hasBackendConfig && window.supabase
  ? window.supabase.createClient(
      appConfig.supabaseUrl,
      appConfig.supabasePublishableKey
    )
  : null;

let currentUser = null;
let currentProfile = null;
let pendingJob = false;
let roleHint = "customer";

const roleLabels = {
  customer: "Kund",
  helper: "Hjälpare",
  company: "Företag"
};

function setNotice(id, message = "", type = "") {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = message;
  element.className = `notice${type ? ` ${type}` : ""}${message ? "" : " hidden"}`;
}

function setLoading(buttonId, isLoading, loadingText, defaultText) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : defaultText;
}

function hideAccountSteps() {
  ["authEmailStep", "authCodeStep", "profileStep", "accountStep"].forEach((id) => {
    document.getElementById(id).classList.add("hidden");
  });
}

function showEmailStep() {
  hideAccountSteps();
  document.getElementById("authEmailStep").classList.remove("hidden");
  document.getElementById("accountTitle").textContent = "Logga in eller skapa konto";
  setNotice("authEmailNotice");
}

function showCodeStep(email) {
  hideAccountSteps();
  document.getElementById("authCodeStep").classList.remove("hidden");
  document.getElementById("codeEmail").textContent = email;
  document.getElementById("accountTitle").textContent = "Ange din kod";
  document.getElementById("authCode").focus();
}

function showProfileStep() {
  hideAccountSteps();
  document.getElementById("profileStep").classList.remove("hidden");
  document.getElementById("accountTitle").textContent = "Skapa din profil";
  document.getElementById("profileRole").value = roleHint;
}

async function showAccountStep() {
  hideAccountSteps();
  document.getElementById("accountStep").classList.remove("hidden");
  document.getElementById("accountTitle").textContent = "Mitt konto";
  document.getElementById("accountName").textContent = currentProfile?.display_name || "Mitt konto";
  document.getElementById("accountEmail").textContent = currentUser?.email || "";
  document.getElementById("accountRole").textContent = roleLabels[currentProfile?.role] || "Kund";
  await loadMyJobs();
}

function openAccountModal(preselectedRole = "customer") {
  roleHint = preselectedRole;
  document.getElementById("accountModal").classList.add("show");

  if (!hasBackendConfig) {
    showEmailStep();
    setNotice(
      "authEmailNotice",
      "Kontosystemet är färdigbyggt men behöver kopplas till projektets databas innan det kan användas.",
      "error"
    );
    return;
  }

  if (currentUser && currentProfile) {
    showAccountStep();
  } else if (currentUser) {
    showProfileStep();
  } else {
    showEmailStep();
    setTimeout(() => document.getElementById("authEmail").focus(), 50);
  }
}

function closeAccountModal() {
  document.getElementById("accountModal").classList.remove("show");
}

async function sendLoginCode() {
  const email = document.getElementById("authEmail").value.trim().toLowerCase();
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
  const email = document.getElementById("authEmail").value.trim().toLowerCase();
  const token = document.getElementById("authCode").value.trim();
  if (!/^\d{6}$/.test(token)) {
    setNotice("authCodeNotice", "Koden ska bestå av sex siffror.", "error");
    return;
  }

  setLoading("verifyCodeBtn", true, "Verifierar…", "Verifiera och fortsätt");
  setNotice("authCodeNotice");
  const { data, error } = await supabaseClient.auth.verifyOtp({
    email,
    token,
    type: "email"
  });
  setLoading("verifyCodeBtn", false, "Verifierar…", "Verifiera och fortsätt");

  if (error || !data.user) {
    setNotice("authCodeNotice", "Koden är felaktig eller har gått ut.", "error");
    return;
  }

  currentUser = data.user;
  await loadProfile();
  if (currentProfile) {
    await showAccountStep();
    maybeOpenPendingJob();
  } else {
    showProfileStep();
  }
}

async function loadProfile() {
  if (!supabaseClient || !currentUser) return null;
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, display_name, phone, role")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (error) {
    setNotice("accountNotice", "Profilen kunde inte hämtas.", "error");
    return null;
  }
  currentProfile = data;
  updateAccountButton();
  return data;
}

async function saveProfile() {
  const displayName = document.getElementById("profileName").value.trim();
  const phone = document.getElementById("profilePhone").value.trim();
  const role = document.getElementById("profileRole").value;

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
      role
    })
    .select("id, display_name, phone, role")
    .single();
  setLoading("saveProfileBtn", false, "Sparar…", "Skapa konto");

  if (error) {
    setNotice("profileNotice", "Profilen kunde inte sparas. Försök igen.", "error");
    return;
  }

  currentProfile = data;
  updateAccountButton();
  await showAccountStep();
  maybeOpenPendingJob();
}

function updateAccountButton() {
  const button = document.getElementById("accountBtn");
  button.textContent = currentUser ? "Mitt konto" : "Logga in";
}

function openModal(type) {
  if (type === "helper") {
    openAccountModal("helper");
    return;
  }

  if (!currentUser || !currentProfile) {
    pendingJob = true;
    openAccountModal("customer");
    return;
  }

  document.getElementById("modal").classList.add("show");
  setNotice("jobNotice");
}

function closeModal() {
  document.getElementById("modal").classList.remove("show");
}

function maybeOpenPendingJob() {
  if (!pendingJob || !currentProfile) return;
  pendingJob = false;
  closeAccountModal();
  setTimeout(() => openModal("job"), 150);
}

function openJobFromAccount() {
  closeAccountModal();
  setTimeout(() => openModal("job"), 150);
}

function parseBudget(value) {
  const digits = String(value).replace(/\D/g, "");
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
    description: document.getElementById("description").value.trim(),
    location: document.getElementById("jobLocation").value.trim(),
    timing: document.getElementById("jobWhen").value,
    budget_sek: parseBudget(document.getElementById("jobBudget").value),
    category: document.getElementById("jobCategory").value
  };

  if (!payload.description || !payload.location || !payload.budget_sek) {
    setNotice("jobNotice", "Fyll i beskrivning, plats och budget.", "error");
    return;
  }

  setLoading("submitBtn", true, "Publicerar…", "Publicera jobb");
  const { error } = await supabaseClient.from("jobs").insert(payload);
  setLoading("submitBtn", false, "Publicerar…", "Publicera jobb");

  if (error) {
    setNotice("jobNotice", "Jobbet kunde inte publiceras. Försök igen.", "error");
    return;
  }

  document.getElementById("jobForm").reset();
  setNotice("jobNotice", "Jobbet är publicerat!", "success");
  setTimeout(() => {
    closeModal();
    openAccountModal();
  }, 900);
}

async function loadMyJobs() {
  const container = document.getElementById("myJobs");
  container.innerHTML = '<div class="account-meta">Hämtar dina jobb…</div>';

  const { data, error } = await supabaseClient
    .from("jobs")
    .select("id, description, location, timing, budget_sek, category, status, created_at")
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
          <h4>${escapeHtml(job.category)}</h4>
          <div class="account-meta">${escapeHtml(job.location)} · ${escapeHtml(job.timing)}</div>
        </div>
        <span class="status-pill">${job.status === "open" ? "Öppet" : escapeHtml(job.status)}</span>
      </div>
      <p>${escapeHtml(job.description)}</p>
      <strong>${Number(job.budget_sek).toLocaleString("sv-SE")} kr</strong>
    </article>
  `).join("");
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
}

async function initializeAuth() {
  if (!supabaseClient) return;
  const { data } = await supabaseClient.auth.getSession();
  currentUser = data.session?.user || null;
  if (currentUser) await loadProfile();
  updateAccountButton();

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    if (currentUser) await loadProfile();
    else currentProfile = null;
    updateAccountButton();
  });
}

document.getElementById("modal").addEventListener("click", function (event) {
  if (event.target === this) closeModal();
});

document.getElementById("accountModal").addEventListener("click", function (event) {
  if (event.target === this) closeAccountModal();
});

document.getElementById("authEmail").addEventListener("keydown", function (event) {
  if (event.key === "Enter") sendLoginCode();
});

document.getElementById("authCode").addEventListener("keydown", function (event) {
  if (event.key === "Enter") verifyLoginCode();
});

initializeAuth();
