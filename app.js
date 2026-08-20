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
let ownJobs = [];
let assignedJobs = [];
let availablePerformers = [];
let selectedChatJobId = null;
let selectedChatOtherLabel = "Den andra personen";
let chatRefreshTimer = null;
let notifications = [];
let notificationRefreshTimer = null;

const profileFields = "id, display_name, phone, account_type, performer_enabled, bio, service_area, skills, role, avatar_path, savings_goal_sek, availability_status, available_until";

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
  byId("accountLogoutBtn")?.classList.add("hidden");
  byId("accountNotificationButton")?.classList.add("hidden");
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
  byId("accountLogoutBtn")?.classList.remove("hidden");
  byId("accountNotificationButton")?.classList.remove("hidden");
  if (byId("accountTitle")) byId("accountTitle").textContent = "Mitt konto";
  if (byId("accountName")) byId("accountName").textContent = currentProfile?.display_name || "Mitt konto";
  if (byId("accountEmail")) byId("accountEmail").textContent = currentUser?.email || "";
  const accountType = currentProfile?.account_type === "company" ? "Företag" : "Privatperson";
  const capability = currentProfile?.performer_enabled ? "Beställare + utförare" : "Beställare";
  if (byId("accountRole")) byId("accountRole").textContent = `${accountType} · ${capability}`;
  byId("findJobsBtn")?.classList.toggle("hidden", !currentProfile?.performer_enabled);
  byId("enablePerformerBtn")?.classList.toggle("hidden", Boolean(currentProfile?.performer_enabled));
  byId("accountTabEarnings")?.classList.toggle("hidden", !currentProfile?.performer_enabled);
  updateProfilePanel();
  showAccountTab("jobs");
  await Promise.all([
    loadMyJobs(),
    currentProfile?.performer_enabled ? loadEarnings() : Promise.resolve()
  ]);
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
  closeAvailabilityMenu();
  closeJobChat();
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
    .select(profileFields)
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
    .select(profileFields)
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
    .select(profileFields)
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
  byId("notificationButton")?.classList.toggle("hidden", !currentUser);
  if (!currentUser) closeNotificationCenter();
}

function showAccountTab(tabName) {
  const requestedTab = tabName === "earnings" && !currentProfile?.performer_enabled ? "jobs" : tabName;
  const tabs = {
    jobs: ["accountTabJobs", "accountJobsPanel"],
    profile: ["accountTabProfile", "accountProfilePanel"],
    earnings: ["accountTabEarnings", "accountEarningsPanel"]
  };
  Object.entries(tabs).forEach(([name, [buttonId, panelId]]) => {
    const isActive = name === requestedTab;
    byId(buttonId)?.classList.toggle("active", isActive);
    byId(buttonId)?.setAttribute("aria-selected", String(isActive));
    byId(panelId)?.classList.toggle("hidden", !isActive);
  });
  const showAvailability = Boolean(currentProfile?.performer_enabled);
  byId("availabilityMenuWrap")?.classList.toggle("hidden", !showAvailability);
  if (!showAvailability) closeAvailabilityMenu();
}

function initials(name) {
  return String(name || "G")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase() || "G";
}

function avatarUrl(path) {
  if (!path || !supabaseClient) return "";
  const { data } = supabaseClient.storage.from("profile-images").getPublicUrl(path);
  return data?.publicUrl || "";
}

function renderAvatar(elementId, path, name) {
  const element = byId(elementId);
  if (!element) return;
  const url = avatarUrl(path);
  element.innerHTML = url
    ? `<img src="${escapeHtml(url)}" alt="" />`
    : escapeHtml(initials(name));
}

function updateProfilePanel() {
  if (!currentProfile) return;
  renderAvatar("accountAvatar", currentProfile.avatar_path, currentProfile.display_name);
  renderAvatar("profileAvatarPreview", currentProfile.avatar_path, currentProfile.display_name);
  if (byId("editProfileName")) byId("editProfileName").value = currentProfile.display_name || "";
  if (byId("editProfileBio")) byId("editProfileBio").value = currentProfile.bio || "";
  if (byId("editProfileArea")) byId("editProfileArea").value = currentProfile.service_area || "";
  if (byId("editProfileSkills")) byId("editProfileSkills").value = (currentProfile.skills || []).join(", ");
  byId("performerProfileFields")?.classList.toggle("hidden", !currentProfile.performer_enabled);
  updateAvailabilityCard();

  const fields = [Boolean(currentProfile.display_name), Boolean(currentProfile.bio), Boolean(currentProfile.avatar_path)];
  if (currentProfile.performer_enabled) fields.push(Boolean(currentProfile.service_area), Boolean(currentProfile.skills?.length));
  const completed = fields.filter(Boolean).length;
  const percent = Math.round((completed / fields.length) * 100);
  if (byId("profileProgressBar")) byId("profileProgressBar").style.width = `${percent}%`;
  if (byId("profileProgressText")) byId("profileProgressText").textContent = `Profilen är ${percent}% komplett. Alla uppgifter utom namn är frivilliga.`;
  if (byId("profilePromptText")) {
    byId("profilePromptText").textContent = percent === 100
      ? "Din profil är komplett och redo att visas för beställare."
      : `Din profil är ${percent}% komplett. Lägg gärna till bild och presentation.`;
  }
}

function activeAvailability(profile = currentProfile) {
  if (!profile?.performer_enabled || !profile.available_until) return "unavailable";
  if (new Date(profile.available_until).getTime() <= Date.now()) return "unavailable";
  return ["now", "today"].includes(profile.availability_status) ? profile.availability_status : "unavailable";
}

function availabilityLabel(status) {
  return ({ now: "Kan hjälpa nu", today: "Kan hjälpa idag", unavailable: "Ingen extra synlighet aktiv" })[status] || "Ingen extra synlighet aktiv";
}

function updateAvailabilityCard() {
  const button = byId("availabilityStatusButton");
  if (!button || !currentProfile) return;
  if (!currentProfile.performer_enabled) return;
  const status = activeAvailability();
  if (byId("availabilityStatusText")) byId("availabilityStatusText").textContent = status === "unavailable" ? "Sätt status" : availabilityLabel(status);
  button.classList.toggle("is-active", status !== "unavailable");
  button.classList.toggle("is-now", status === "now");
  byId("clearAvailabilityBtn")?.classList.toggle("hidden", status === "unavailable");
  if (byId("availabilityExpiry")) {
    const expiry = status === "unavailable" ? "" : new Date(currentProfile.available_until).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
    byId("availabilityExpiry").textContent = status === "now"
      ? `Visas högst upp till cirka ${expiry}.`
      : status === "today"
        ? "Gäller till midnatt och stängs sedan av automatiskt."
        : "Slå på statusen när du vill synas för beställare.";
  }
}

function toggleAvailabilityMenu() {
  const popover = byId("availabilityPopover");
  const button = byId("availabilityStatusButton");
  if (!popover || !button) return;
  const willOpen = popover.classList.contains("hidden");
  popover.classList.toggle("hidden", !willOpen);
  button.setAttribute("aria-expanded", String(willOpen));
}

function closeAvailabilityMenu() {
  byId("availabilityPopover")?.classList.add("hidden");
  byId("availabilityStatusButton")?.setAttribute("aria-expanded", "false");
}

function notificationIcon(type) {
  return ({
    job_match: "✨",
    application_sent: "↗",
    job_application: "🙋",
    job_accepted: "✓",
    application_declined: "–",
    job_started: "▶",
    job_completed: "✓",
    payout_ready: "kr",
    new_message: "💬"
  })[type] || "•";
}

function updateNotificationBadge() {
  const unreadCount = notifications.filter((notification) => !notification.read_at).length;
  ["notificationBadge", "accountNotificationBadge"].forEach((id) => {
    const badge = byId(id);
    if (!badge) return;
    badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    badge.classList.toggle("hidden", unreadCount === 0);
  });
  ["notificationButton", "accountNotificationButton"].forEach((id) => {
    byId(id)?.setAttribute("aria-label", unreadCount ? `Öppna notiser, ${unreadCount} olästa` : "Öppna notiser");
  });
}

function renderNotifications() {
  const list = byId("notificationList");
  if (!list) return;
  list.innerHTML = notifications.length
    ? notifications.map((notification) => `
        <button class="notification-item ${notification.read_at ? "" : "is-unread"}" type="button" onclick="openNotification(${notification.id}, ${notification.job_id || "null"})">
          <span class="notification-icon" aria-hidden="true">${escapeHtml(notificationIcon(notification.type))}</span>
          <span class="notification-copy">
            <strong>${escapeHtml(notification.title)}</strong>
            <span>${escapeHtml(notification.body || "")}</span>
            <time datetime="${escapeHtml(notification.created_at)}">${escapeHtml(formatRelativeDate(notification.created_at))}</time>
          </span>
        </button>`).join("")
    : '<div class="notification-empty"><strong>Inga notiser ännu</strong><br><span>Här ser du när något händer med dina jobb.</span></div>';
  byId("markAllNotificationsBtn")?.classList.toggle("hidden", !notifications.some((notification) => !notification.read_at));
  updateNotificationBadge();
}

async function loadNotifications() {
  if (!supabaseClient || !currentUser || !byId("notificationList")) return;
  const { data, error } = await supabaseClient
    .from("notifications")
    .select("id, type, title, body, job_id, read_at, created_at")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) {
    byId("notificationList").innerHTML = '<div class="notification-empty">Notiscentret behöver aktiveras i databasen.</div>';
    return;
  }
  notifications = data || [];
  renderNotifications();
}

async function toggleNotificationCenter() {
  if (!currentUser) return;
  const center = byId("notificationCenter");
  if (!center) return;
  const willOpen = center.classList.contains("hidden");
  center.classList.toggle("hidden", !willOpen);
  ["notificationButton", "accountNotificationButton"].forEach((id) => byId(id)?.setAttribute("aria-expanded", String(willOpen)));
  if (willOpen) await loadNotifications();
}

function closeNotificationCenter() {
  byId("notificationCenter")?.classList.add("hidden");
  ["notificationButton", "accountNotificationButton"].forEach((id) => byId(id)?.setAttribute("aria-expanded", "false"));
}

async function markNotificationRead(notificationId) {
  const notification = notifications.find((item) => Number(item.id) === Number(notificationId));
  if (!notification || notification.read_at) return;
  const readAt = new Date().toISOString();
  const { error } = await supabaseClient
    .from("notifications")
    .update({ read_at: readAt })
    .eq("id", notificationId)
    .eq("user_id", currentUser.id);
  if (!error) {
    notification.read_at = readAt;
    renderNotifications();
  }
}

async function markAllNotificationsRead() {
  if (!currentUser || !notifications.some((notification) => !notification.read_at)) return;
  const readAt = new Date().toISOString();
  const { error } = await supabaseClient
    .from("notifications")
    .update({ read_at: readAt })
    .eq("user_id", currentUser.id)
    .is("read_at", null);
  if (!error) {
    notifications.forEach((notification) => { notification.read_at ||= readAt; });
    renderNotifications();
  }
}

async function openNotification(notificationId, jobId) {
  await markNotificationRead(notificationId);
  closeNotificationCenter();
  if (jobId) {
    openAccountModal();
    window.setTimeout(() => showAccountTab("jobs"), 100);
  }
}

function startNotificationRefresh() {
  if (notificationRefreshTimer) window.clearInterval(notificationRefreshTimer);
  notificationRefreshTimer = null;
  if (!currentUser) return;
  loadNotifications();
  notificationRefreshTimer = window.setInterval(loadNotifications, 30000);
}

function setAvailabilityLoading(isLoading) {
  ["availabilityNowBtn", "availabilityTodayBtn", "clearAvailabilityBtn"].forEach((id) => {
    if (byId(id)) byId(id).disabled = isLoading;
  });
}

async function saveAvailabilityStatus(status) {
  if (!currentUser || !currentProfile?.performer_enabled) return;
  if (!["now", "today", "unavailable"].includes(status)) return;
  setAvailabilityLoading(true);
  setNotice("accountNotice");
  const { data, error } = await supabaseClient.rpc("set_my_availability", { p_status: status });
  setAvailabilityLoading(false);
  if (error || !data?.length) {
    setNotice("accountNotice", "Statusen kunde inte sparas. Kontrollera att databasuppdateringen är körd.", "error");
    return;
  }
  currentProfile.availability_status = data[0].availability_status;
  currentProfile.available_until = data[0].available_until;
  updateAvailabilityCard();
  closeAvailabilityMenu();
  setNotice("accountNotice", status === "unavailable" ? "Du visas inte längre som tillgänglig." : "Din tillgänglighet är uppdaterad.", "success");
}

async function uploadProfileAvatar(file) {
  if (!file) return currentProfile?.avatar_path || null;
  const allowedTypes = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const extension = allowedTypes[file.type];
  if (!extension || file.size > 5 * 1024 * 1024) throw new Error("invalid-avatar");
  const path = `${currentUser.id}/${Date.now()}.${extension}`;
  const { error } = await supabaseClient.storage
    .from("profile-images")
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) throw error;
  return path;
}

async function saveOptionalProfile() {
  if (!currentUser || !currentProfile) return;
  const displayName = byId("editProfileName")?.value.trim() || "";
  const bio = byId("editProfileBio")?.value.trim() || "";
  const serviceArea = byId("editProfileArea")?.value.trim() || "";
  const skills = (byId("editProfileSkills")?.value || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 12);
  const file = byId("profileAvatarInput")?.files?.[0] || null;
  if (displayName.length < 2) {
    setNotice("accountNotice", "Ange ett namn med minst två tecken.", "error");
    return;
  }
  setLoading("saveOptionalProfileBtn", true, "Sparar…", "Spara profil");
  setNotice("accountNotice");
  try {
    const previousAvatarPath = currentProfile.avatar_path;
    const avatarPath = await uploadProfileAvatar(file);
    const updates = { display_name: displayName, bio: bio || null, avatar_path: avatarPath };
    if (currentProfile.performer_enabled) {
      updates.service_area = serviceArea || null;
      updates.skills = skills;
    }
    const { data, error } = await supabaseClient
      .from("profiles")
      .update(updates)
      .eq("id", currentUser.id)
      .select(profileFields)
      .single();
    if (error) throw error;
    currentProfile = data;
    if (file && previousAvatarPath && previousAvatarPath !== avatarPath) {
      await supabaseClient.storage.from("profile-images").remove([previousAvatarPath]);
    }
    if (byId("profileAvatarInput")) byId("profileAvatarInput").value = "";
    if (byId("accountName")) byId("accountName").textContent = currentProfile.display_name;
    updateProfilePanel();
    setNotice("accountNotice", "Profilen har sparats.", "success");
  } catch (error) {
    const message = error?.message === "invalid-avatar"
      ? "Välj en JPG-, PNG- eller WebP-bild som är mindre än 5 MB."
      : "Profilen kunde inte sparas. Försök igen.";
    setNotice("accountNotice", message, "error");
  } finally {
    setLoading("saveOptionalProfileBtn", false, "Sparar…", "Spara profil");
  }
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
  renderJobModalPerformers();
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
  container.innerHTML = '<div class="account-meta">Hämtar dina jobb och uppdrag…</div>';
  const jobFields = "id, user_id, title, description, location, timing, budget_sek, price_type, category, status, created_at, updated_at, performer_id, agreed_price_sek, accepted_at, started_at, completed_at";
  const [ownedResult, assignedResult, availabilityResult] = await Promise.all([
    supabaseClient
      .from("jobs")
      .select(jobFields)
      .eq("user_id", currentUser.id)
      .order("updated_at", { ascending: false }),
    currentProfile?.performer_enabled
      ? supabaseClient
          .from("jobs")
          .select(jobFields)
          .eq("performer_id", currentUser.id)
          .in("status", ["accepted", "in_progress", "completed"])
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    supabaseClient.rpc("get_available_performers")
  ]);
  if (ownedResult.error || assignedResult.error) {
    container.innerHTML = '<div class="notice error">Jobben kunde inte hämtas.</div>';
    return;
  }
  const availabilityByPerformer = new Map((availabilityResult.data || []).map((performer) => [performer.id, performer.availability_status]));
  ownJobs = await Promise.all((ownedResult.data || []).map(async (job) => {
    const { data: applications } = await supabaseClient.rpc("get_job_applications", { p_job_id: job.id });
    let review = null;
    if (job.status === "completed" && job.performer_id) {
      const result = await supabaseClient
        .from("reviews")
        .select("id, rating, comment")
        .eq("job_id", job.id)
        .maybeSingle();
      review = result.data || null;
    }
    const applicationsWithAvailability = (applications || []).map((application) => ({
      ...application,
      availability_status: availabilityByPerformer.get(application.performer_id) || null
    }));
    return { ...job, applications: applicationsWithAvailability, review };
  }));
  assignedJobs = assignedResult.data || [];

  const assignedSection = currentProfile?.performer_enabled
    ? `<section class="account-job-group">
        <div class="account-job-group-head">
          <div><h4>Jobb jag utför</h4><span>Accepterade, pågående och slutförda uppdrag</span></div>
          <span class="status-pill">${assignedJobs.length}</span>
        </div>
        ${assignedJobs.length
          ? assignedJobs.map((job) => renderAccountJob(job, "performer")).join("")
          : '<div class="notice">Du har inget accepterat eller pågående uppdrag ännu.</div>'}
      </section>`
    : "";
  const ownedSection = `<section class="account-job-group">
      <div class="account-job-group-head">
        <div><h4>Jobb jag lagt upp</h4><span>Dina förfrågningar och valda utförare</span></div>
        <span class="status-pill">${ownJobs.length}</span>
      </div>
      ${ownJobs.length
        ? ownJobs.map((job) => renderAccountJob(job, "owner")).join("")
        : '<div class="notice">Du har inte lagt upp något jobb ännu.</div>'}
    </section>`;
  container.innerHTML = `${assignedSection}${ownedSection}`;
}

function renderAccountJob(job, relationship) {
  const isOwner = relationship === "owner";
  const canChat = ["accepted", "in_progress", "completed"].includes(job.status);
  const statusHelp = ({
    open: "Väntar på intresseanmälningar",
    accepted: "Utföraren är vald – använd chatten för att planera jobbet",
    in_progress: "Jobbet har startats och pågår",
    completed: "Beställaren har bekräftat att jobbet är klart",
    cancelled: "Jobbet är avslutat utan utförande"
  })[job.status] || "";
  return `
    <article class="job-row">
      <div class="job-row-top">
        <div>
          <h4>${escapeHtml(job.title || job.category)}</h4>
          <div class="account-meta">${escapeHtml(job.location)} · ${escapeHtml(job.timing)}</div>
        </div>
        <span class="status-pill">${statusLabel(job.status)}</span>
      </div>
      <p>${escapeHtml(job.description)}</p>
      ${renderJobProgress(job.status)}
      ${statusHelp ? `<div class="job-status-help">${escapeHtml(statusHelp)}</div>` : ""}
      <div class="job-row-footer">
        <strong>${job.agreed_price_sek ? `${formatCurrency(job.agreed_price_sek)} överenskommet` : formatPrice(job)}</strong>
        <div class="account-actions">
          ${canChat ? `<button class="btn btn-light btn-small" type="button" onclick="openJobChat(${job.id})">Öppna chatt</button>` : ""}
          ${job.status === "accepted" ? `<button class="btn btn-primary btn-small" id="startJobBtn-${job.id}" type="button" onclick="startJob(${job.id})">Markera som pågående</button>` : ""}
          ${isOwner && job.status === "in_progress" ? `<button class="btn btn-primary btn-small" id="completeJobBtn-${job.id}" type="button" onclick="markJobCompleted(${job.id})">Bekräfta som klart</button>` : ""}
          ${isOwner && ["open", "cancelled"].includes(job.status) ? `<button class="btn btn-danger btn-small" id="deleteJobBtn-${job.id}" type="button" onclick="deleteJob(${job.id})">Ta bort jobb</button>` : ""}
        </div>
      </div>
      ${isOwner ? renderJobApplications(job) : ""}
      ${isOwner ? renderReviewBox(job) : ""}
    </article>
  `;
}

function renderJobProgress(status) {
  const order = ["accepted", "in_progress", "completed"];
  const currentIndex = order.indexOf(status);
  if (currentIndex < 0) return "";
  return `<div class="job-progress" aria-label="Jobbets status">
    ${order.map((step, index) => `<div class="job-progress-step ${index <= currentIndex ? "is-done" : ""} ${index === currentIndex ? "is-current" : ""}">
      <span>${index + 1}</span><strong>${statusLabel(step)}</strong>
    </div>`).join("")}
  </div>`;
}

function renderJobApplications(job) {
  if (!["open", "accepted", "in_progress"].includes(job.status)) return "";
  if (!job.applications.length) {
    return '<div class="job-applications"><h5>Intresseanmälningar</h5><div class="account-meta">Ingen har anmält intresse ännu.</div></div>';
  }
  const visibleApplications = job.status !== "open"
    ? job.applications.filter((application) => application.status === "accepted")
    : job.applications;
  return `
    <div class="job-applications">
      <h5>${job.status !== "open" ? "Vald utförare" : `Intresseanmälningar (${job.applications.length})`}</h5>
      ${visibleApplications.map((application) => {
        const proposedPrice = application.proposed_price_sek
          ? formatCurrency(application.proposed_price_sek)
          : "Inget prisförslag";
        const rating = Number(application.average_rating || 0);
        const ratingCount = Number(application.review_count || 0);
        return `
          <div class="application-card">
            <div class="application-avatar">${application.avatar_path ? `<img src="${escapeHtml(avatarUrl(application.avatar_path))}" alt="" />` : escapeHtml(initials(application.display_name))}</div>
            <div>
              <h6>${escapeHtml(application.display_name || "Utförare")}</h6>
              ${application.availability_status ? `<span class="availability-badge"><span aria-hidden="true"></span>${availabilityLabel(application.availability_status)}</span>` : ""}
              <div class="rating-line">${ratingCount ? `${rating.toFixed(1).replace(".", ",")} ★ · ${ratingCount} ${ratingCount === 1 ? "betyg" : "betyg"}` : "Ny utförare · inga betyg ännu"}</div>
              ${application.bio ? `<p>${escapeHtml(application.bio)}</p>` : ""}
              <div class="account-meta">${escapeHtml(application.service_area || "Område saknas")} · ${escapeHtml(proposedPrice)}</div>
              <p>${escapeHtml(application.message)}</p>
            </div>
            <div class="application-actions">
              ${job.status === "open" && application.status === "pending" ? `<button class="btn btn-primary btn-small" type="button" onclick="acceptApplication(${application.application_id}, ${job.id})">Välj utförare</button>` : `<span class="status-pill">${application.status === "accepted" ? "Vald" : "Ej vald"}</span>`}
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

function renderReviewBox(job) {
  if (job.status !== "completed" || !job.performer_id) return "";
  if (job.review) {
    return `<div class="review-box"><strong>Ditt betyg: ${"★".repeat(job.review.rating)}${"☆".repeat(5 - job.review.rating)}</strong>${job.review.comment ? `<span>${escapeHtml(job.review.comment)}</span>` : ""}</div>`;
  }
  return `
    <div class="review-box">
      <strong>Hur gick jobbet?</strong>
      <span class="account-meta">Betyget visas på utförarens profil.</span>
      <div class="review-controls">
        <div class="field">
          <label for="reviewRating-${job.id}">Betyg</label>
          <select id="reviewRating-${job.id}">
            <option value="5">5 – Utmärkt</option><option value="4">4 – Mycket bra</option><option value="3">3 – Bra</option><option value="2">2 – Mindre bra</option><option value="1">1 – Dåligt</option>
          </select>
        </div>
        <div class="field">
          <label for="reviewComment-${job.id}">Kommentar <span class="optional-label">Frivilligt</span></label>
          <input id="reviewComment-${job.id}" maxlength="600" placeholder="Skriv några ord om upplevelsen" />
        </div>
        <button class="btn btn-primary btn-small" id="reviewBtn-${job.id}" type="button" onclick="submitReview(${job.id})">Lämna betyg</button>
      </div>
    </div>`;
}

async function acceptApplication(applicationId, jobId) {
  const job = ownJobs.find((item) => Number(item.id) === Number(jobId));
  const application = job?.applications.find((item) => Number(item.application_id) === Number(applicationId));
  if (!job || !application) return;
  const suggestedPrice = application.proposed_price_sek || job.budget_sek;
  const enteredPrice = window.prompt("Bekräfta överenskommet pris i kronor:", suggestedPrice);
  if (enteredPrice === null) return;
  const agreedPrice = parseBudget(enteredPrice);
  if (!agreedPrice) {
    setNotice("accountNotice", "Ange ett giltigt överenskommet pris.", "error");
    return;
  }
  const { error } = await supabaseClient.rpc("accept_job_application", {
    p_application_id: applicationId,
    p_agreed_price_sek: agreedPrice
  });
  if (error) {
    setNotice("accountNotice", "Utföraren kunde inte väljas. Försök igen.", "error");
    return;
  }
  setNotice("accountNotice", "Utföraren är vald. Jobbet är accepterat och chatten är nu öppen.", "success");
  await loadMyJobs();
}

async function startJob(jobId) {
  if (!window.confirm("Vill du markera jobbet som pågående?")) return;
  setLoading(`startJobBtn-${jobId}`, true, "Sparar…", "Markera som pågående");
  const { error } = await supabaseClient.rpc("start_job", { p_job_id: jobId });
  if (error) {
    setLoading(`startJobBtn-${jobId}`, false, "Sparar…", "Markera som pågående");
    setNotice("accountNotice", "Jobbet kunde inte startas. Försök igen.", "error");
    return;
  }
  setNotice("accountNotice", "Jobbet är nu markerat som pågående.", "success");
  await loadMyJobs();
}

async function markJobCompleted(jobId) {
  if (!window.confirm("Bekräftar du som beställare att jobbet är utfört och klart? Därefter kan du lämna ett betyg.")) return;
  setLoading(`completeJobBtn-${jobId}`, true, "Sparar…", "Bekräfta som klart");
  const { error } = await supabaseClient.rpc("complete_job", { p_job_id: jobId });
  if (error) {
    setLoading(`completeJobBtn-${jobId}`, false, "Sparar…", "Bekräfta som klart");
    setNotice("accountNotice", "Jobbet kunde inte markeras som klart.", "error");
    return;
  }
  setNotice("accountNotice", "Jobbet är markerat som klart. Nu kan du lämna ett betyg.", "success");
  await loadMyJobs();
}

async function submitReview(jobId) {
  const job = ownJobs.find((item) => Number(item.id) === Number(jobId));
  if (!job?.performer_id) return;
  const rating = Number(byId(`reviewRating-${jobId}`)?.value || 0);
  const comment = byId(`reviewComment-${jobId}`)?.value.trim() || "";
  setLoading(`reviewBtn-${jobId}`, true, "Skickar…", "Lämna betyg");
  const { error } = await supabaseClient.from("reviews").insert({
    job_id: jobId,
    reviewer_id: currentUser.id,
    reviewee_id: job.performer_id,
    rating,
    comment: comment || null
  });
  if (error) {
    setLoading(`reviewBtn-${jobId}`, false, "Skickar…", "Lämna betyg");
    setNotice("accountNotice", "Betyget kunde inte sparas.", "error");
    return;
  }
  setNotice("accountNotice", "Tack! Betyget har sparats.", "success");
  await loadMyJobs();
}

async function deleteJob(jobId) {
  if (!supabaseClient || !currentUser) return;
  const confirmed = window.confirm("Vill du verkligen ta bort jobbet? Det går inte att ångra.");
  if (!confirmed) return;
  setLoading(`deleteJobBtn-${jobId}`, true, "Tar bort…", "Ta bort jobb");
  setNotice("accountNotice");
  const { error } = await supabaseClient
    .from("jobs")
    .delete()
    .eq("id", jobId)
    .eq("user_id", currentUser.id);
  if (error) {
    setLoading(`deleteJobBtn-${jobId}`, false, "Tar bort…", "Ta bort jobb");
    setNotice("accountNotice", "Jobbet kunde inte tas bort. Försök igen.", "error");
    return;
  }
  publicJobs = publicJobs.filter((job) => Number(job.id) !== Number(jobId));
  if (byId("publicJobs")) applyJobFilters();
  await loadMyJobs();
  setNotice("accountNotice", "Jobbet har tagits bort.", "success");
}

function findAccountJob(jobId) {
  return [...ownJobs, ...assignedJobs].find((job) => Number(job.id) === Number(jobId));
}

async function openJobChat(jobId) {
  const job = findAccountJob(jobId);
  if (!job || !["accepted", "in_progress", "completed"].includes(job.status)) return;
  selectedChatJobId = Number(jobId);
  selectedChatOtherLabel = job.user_id === currentUser.id ? "Utföraren" : "Beställaren";
  if (byId("jobChatTitle")) byId("jobChatTitle").textContent = job.title || job.category || "Jobb";
  byId("jobChatForm")?.classList.toggle("hidden", job.status === "completed");
  setNotice("jobChatNotice", job.status === "completed" ? "Jobbet är avslutat. Chatten är sparad men stängd för nya meddelanden." : "");
  byId("jobChatModal")?.classList.add("show");
  await loadJobMessages();
  if (chatRefreshTimer) window.clearInterval(chatRefreshTimer);
  chatRefreshTimer = window.setInterval(loadJobMessages, 5000);
  if (job.status !== "completed") setTimeout(() => byId("jobChatInput")?.focus(), 80);
}

function closeJobChat() {
  if (chatRefreshTimer) window.clearInterval(chatRefreshTimer);
  chatRefreshTimer = null;
  selectedChatJobId = null;
  selectedChatOtherLabel = "Den andra personen";
  byId("jobChatModal")?.classList.remove("show");
  if (byId("jobChatMessages")) byId("jobChatMessages").innerHTML = "";
  if (byId("jobChatInput")) byId("jobChatInput").value = "";
  setNotice("jobChatNotice");
}

async function loadJobMessages() {
  const container = byId("jobChatMessages");
  if (!container || !selectedChatJobId || !currentUser) return;
  if (!container.children.length) container.innerHTML = '<div class="account-meta">Hämtar meddelanden…</div>';
  const { data, error } = await supabaseClient
    .from("job_messages")
    .select("id, sender_id, body, created_at")
    .eq("job_id", selectedChatJobId)
    .order("created_at", { ascending: true });
  if (error) {
    container.innerHTML = '<div class="notice error">Chatten kunde inte hämtas.</div>';
    return;
  }
  const messages = data || [];
  container.innerHTML = messages.length
    ? messages.map((message) => {
        const isOwn = message.sender_id === currentUser.id;
        const timestamp = new Date(message.created_at).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        return `<div class="chat-message ${isOwn ? "is-own" : "is-other"}">
          <div>${escapeHtml(message.body)}</div>
          <span>${isOwn ? "Du" : selectedChatOtherLabel} · ${escapeHtml(timestamp)}</span>
        </div>`;
      }).join("")
    : '<div class="chat-empty"><strong>Starta planeringen här</strong><span>Bestäm tid, plats och praktiska detaljer om jobbet.</span></div>';
  container.scrollTop = container.scrollHeight;
}

async function sendJobMessage(event) {
  event.preventDefault();
  if (!selectedChatJobId || !currentUser) return;
  const input = byId("jobChatInput");
  const body = input?.value.trim() || "";
  if (!body) return;
  setLoading("jobChatSendBtn", true, "Skickar…", "Skicka");
  setNotice("jobChatNotice");
  const { error } = await supabaseClient.from("job_messages").insert({
    job_id: selectedChatJobId,
    sender_id: currentUser.id,
    body
  });
  setLoading("jobChatSendBtn", false, "Skickar…", "Skicka");
  if (error) {
    setNotice("jobChatNotice", "Meddelandet kunde inte skickas.", "error");
    return;
  }
  input.value = "";
  await loadJobMessages();
  input.focus();
}

async function loadEarnings() {
  if (!currentUser || !currentProfile?.performer_enabled) return;
  const [jobsResult, reviewsResult] = await Promise.all([
    supabaseClient
      .from("jobs")
      .select("id, title, agreed_price_sek, budget_sek, completed_at")
      .eq("performer_id", currentUser.id)
      .eq("status", "completed")
      .order("completed_at", { ascending: false }),
    supabaseClient
      .from("reviews")
      .select("rating")
      .eq("reviewee_id", currentUser.id)
  ]);
  if (jobsResult.error || reviewsResult.error) {
    if (byId("earningsList")) byId("earningsList").innerHTML = '<div class="notice error">Statistiken kunde inte hämtas.</div>';
    return;
  }
  const completedJobs = jobsResult.data || [];
  const ratings = reviewsResult.data || [];
  const total = completedJobs.reduce((sum, job) => sum + Number(job.agreed_price_sek || job.budget_sek || 0), 0);
  const average = ratings.length
    ? ratings.reduce((sum, review) => sum + Number(review.rating), 0) / ratings.length
    : 0;
  if (byId("totalEarnings")) byId("totalEarnings").textContent = formatCurrency(total);
  if (byId("completedJobsCount")) byId("completedJobsCount").textContent = String(completedJobs.length);
  if (byId("averageRating")) byId("averageRating").textContent = ratings.length
    ? `${average.toFixed(1).replace(".", ",")} ★ (${ratings.length})`
    : "Inga betyg";
  if (byId("savingsGoalInput")) byId("savingsGoalInput").value = currentProfile.savings_goal_sek || "";
  updateGoalProgress(total, Number(currentProfile.savings_goal_sek || 0));
  if (byId("earningsList")) {
    byId("earningsList").innerHTML = completedJobs.length
      ? `<strong>Utförda jobb</strong>${completedJobs.map((job) => `
          <div class="earning-row">
            <span><strong>${escapeHtml(job.title)}</strong><br><span class="account-meta">${new Date(job.completed_at).toLocaleDateString("sv-SE")}</span></span>
            <strong>${formatCurrency(job.agreed_price_sek || job.budget_sek)}</strong>
          </div>`).join("")}`
      : '<div class="notice">När ett jobb markeras som klart visas summan här.</div>';
  }
}

function updateGoalProgress(total, goal) {
  const percent = goal > 0 ? Math.min(100, Math.round((total / goal) * 100)) : 0;
  if (byId("goalProgressBar")) byId("goalProgressBar").style.width = `${percent}%`;
  if (byId("goalProgressText")) {
    byId("goalProgressText").textContent = goal > 0
      ? `${formatCurrency(total)} av ${formatCurrency(goal)} · ${percent}%`
      : "Inget mål satt ännu.";
  }
}

async function saveSavingsGoal() {
  if (!currentUser || !currentProfile) return;
  const goal = parseBudget(byId("savingsGoalInput")?.value || "");
  if (!goal) {
    setNotice("accountNotice", "Ange ett sparmål i kronor.", "error");
    return;
  }
  setLoading("saveGoalBtn", true, "Sparar…", "Spara mål");
  const { error } = await supabaseClient
    .from("profiles")
    .update({ savings_goal_sek: goal })
    .eq("id", currentUser.id);
  setLoading("saveGoalBtn", false, "Sparar…", "Spara mål");
  if (error) {
    setNotice("accountNotice", "Sparmålet kunde inte sparas.", "error");
    return;
  }
  currentProfile.savings_goal_sek = goal;
  setNotice("accountNotice", "Sparmålet har sparats.", "success");
  await loadEarnings();
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

async function loadAvailablePerformers() {
  const container = byId("availablePerformers");
  if (!container) return;
  if (!supabaseClient) {
    container.innerHTML = '<div class="notice error">Utförarlistan är inte ansluten ännu.</div>';
    return;
  }
  const { data, error } = await supabaseClient.rpc("get_available_performers");
  if (error) {
    byId("availabilitySection")?.classList.remove("hidden");
    if (byId("performersCount")) byId("performersCount").textContent = "Listan kunde inte laddas";
    container.innerHTML = '<div class="notice error">Utförarna kunde inte hämtas. Databasuppdateringen kan saknas.</div>';
    return;
  }
  availablePerformers = data || [];
  byId("availabilitySection")?.classList.toggle("hidden", !availablePerformers.length);
  applyPerformerFilters();
  renderJobModalPerformers();
}

function renderJobModalPerformers() {
  const container = byId("jobModalPerformers");
  if (!container) return;
  const performers = availablePerformers.slice(0, 5);
  if (!performers.length) {
    container.innerHTML = '<div class="account-meta">Ingen har markerat sig som tillgänglig just nu. Jobbet visas ändå för alla utförare när det publiceras.</div>';
    return;
  }
  container.innerHTML = performers.map((performer) => `
    <div class="job-live-person">
      <div class="job-live-person-avatar">${performer.avatar_path ? `<img src="${escapeHtml(avatarUrl(performer.avatar_path))}" alt="" />` : escapeHtml(initials(performer.display_name))}</div>
      <div class="job-live-person-copy">
        <span class="availability-badge"><span aria-hidden="true"></span>${availabilityLabel(performer.availability_status)}</span>
        <strong>${escapeHtml(performer.display_name || "Utförare")}</strong>
        <span>${escapeHtml(performer.service_area || "Område ej angivet")}</span>
      </div>
    </div>`).join("");
}

function applyPerformerFilters() {
  if (!byId("availablePerformers")) return;
  const search = (byId("performerSearchFilter")?.value || "").trim().toLowerCase();
  const area = (byId("performerAreaFilter")?.value || "").trim().toLowerCase();
  const filtered = availablePerformers.filter((performer) => {
    const searchable = `${performer.display_name || ""} ${performer.bio || ""} ${(performer.skills || []).join(" ")}`.toLowerCase();
    return (!search || searchable.includes(search))
      && (!area || String(performer.service_area || "").toLowerCase().includes(area));
  });
  renderAvailablePerformers(filtered);
}

function renderAvailablePerformers(performers) {
  const container = byId("availablePerformers");
  if (!container) return;
  if (byId("performersCount")) {
    byId("performersCount").textContent = `${performers.length} ${performers.length === 1 ? "utförare är tillgänglig" : "utförare är tillgängliga"}`;
  }
  if (!performers.length) {
    container.innerHTML = `
      <div class="empty-state performer-empty">
        <h2>Ingen matchar sökningen just nu</h2>
        <p>Prova ett annat område eller kom tillbaka senare. Du kan också lägga upp jobbet så att utförare kan anmäla intresse.</p>
        <a class="btn btn-primary" href="index.html?newJob=1">Lägg upp ett jobb</a>
      </div>`;
    return;
  }
  const limit = Number(container.dataset.performerLimit || 0);
  const visiblePerformers = limit ? performers.slice(0, limit) : performers;
  container.innerHTML = visiblePerformers.map((performer) => {
    const rating = Number(performer.average_rating || 0);
    const reviewCount = Number(performer.review_count || 0);
    const skills = (performer.skills || []).slice(0, 5);
    return `
      <article class="performer-card ${performer.availability_status === "now" ? "is-now" : ""}">
        <div class="performer-card-head">
          <div class="performer-avatar">${performer.avatar_path ? `<img src="${escapeHtml(avatarUrl(performer.avatar_path))}" alt="" />` : escapeHtml(initials(performer.display_name))}</div>
          <div>
            <span class="availability-badge"><span aria-hidden="true"></span>${availabilityLabel(performer.availability_status)}</span>
            <h2>${escapeHtml(performer.display_name || "Utförare")}</h2>
            <div class="rating-line">${reviewCount ? `${rating.toFixed(1).replace(".", ",")} ★ · ${reviewCount} betyg` : "Ny utförare · inga betyg ännu"}</div>
          </div>
        </div>
        ${performer.bio ? `<p>${escapeHtml(performer.bio)}</p>` : '<p class="account-meta">Ingen presentation ännu.</p>'}
        <div class="performer-details">
          <span>📍 ${escapeHtml(performer.service_area || "Område ej angivet")}</span>
          <span>✓ ${Number(performer.completed_jobs || 0)} utförda jobb</span>
        </div>
        ${skills.length ? `<div class="skill-list">${skills.map((skill) => `<span>${escapeHtml(skill)}</span>`).join("")}</div>` : ""}
        <a class="btn btn-primary" href="index.html?newJob=1">Lägg upp jobb</a>
      </article>`;
  }).join("");
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
  await loadNotifications();
}

function formatPrice(job) {
  const amount = Number(job.budget_sek || 0).toLocaleString("sv-SE");
  if (job.price_type === "hourly") return `${amount} kr/tim`;
  if (job.price_type === "quote") return `Ca ${amount} kr`;
  return `${amount} kr`;
}

function formatCurrency(value) {
  return `${Number(value || 0).toLocaleString("sv-SE")} kr`;
}

function formatRelativeDate(value) {
  const diffHours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3600000));
  if (diffHours < 1) return "Nyss";
  if (diffHours < 24) return `${diffHours} tim sedan`;
  const days = Math.floor(diffHours / 24);
  return `${days} ${days === 1 ? "dag" : "dagar"} sedan`;
}

function statusLabel(status) {
  return ({ open: "Öppet", matched: "Accepterat", accepted: "Accepterat", in_progress: "Pågående", completed: "Klart", cancelled: "Avbrutet" })[status] || escapeHtml(status);
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
  closeNotificationCenter();
  closeJobChat();
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  ownJobs = [];
  assignedJobs = [];
  notifications = [];
  if (notificationRefreshTimer) window.clearInterval(notificationRefreshTimer);
  notificationRefreshTimer = null;
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
    startNotificationRefresh();
    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
      currentUser = session?.user || null;
      if (currentUser) await loadProfile();
      else {
        currentProfile = null;
        notifications = [];
      }
      updateAccountButton();
      startNotificationRefresh();
      if (byId("publicJobs")) renderPublicJobs(publicJobs);
    });
  }
  if (byId("publicJobs")) await loadPublicJobs();
  if (byId("availablePerformers")) await loadAvailablePerformers();
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
  byId("jobChatModal")?.addEventListener("click", function (event) { if (event.target === this) closeJobChat(); });
  document.addEventListener("click", (event) => {
    const notificationCenter = byId("notificationCenter");
    const notificationButtons = [byId("notificationButton"), byId("accountNotificationButton")].filter(Boolean);
    if (notificationCenter && !notificationCenter.contains(event.target) && !notificationButtons.some((button) => button.contains(event.target))) closeNotificationCenter();
    const availabilityWrap = byId("availabilityMenuWrap");
    if (availabilityWrap && !availabilityWrap.contains(event.target)) closeAvailabilityMenu();
  });
  byId("authEmail")?.addEventListener("keydown", (event) => { if (event.key === "Enter") sendLoginCode(); });
  byId("authCode")?.addEventListener("keydown", (event) => { if (event.key === "Enter") verifyLoginCode(); });
  byId("profileAvatarInput")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
      event.target.value = "";
      setNotice("accountNotice", "Välj en bild som är mindre än 5 MB.", "error");
      return;
    }
    const preview = byId("profileAvatarPreview");
    if (preview) preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="" />`;
  });
  ["filterSearch", "filterCategory", "filterLocation", "filterTiming", "filterMinBudget", "filterSort"].forEach((id) => {
    const element = byId(id);
    if (!element) return;
    const eventName = ["filterSearch", "filterLocation", "filterMinBudget"].includes(id) ? "input" : "change";
    element.addEventListener(eventName, applyJobFilters);
  });
  ["performerSearchFilter", "performerAreaFilter"].forEach((id) => {
    byId(id)?.addEventListener("input", applyPerformerFilters);
  });
}

attachPageEvents();
initializeAuth();
