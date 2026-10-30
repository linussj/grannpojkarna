const appConfig = window.GRANNPOJKARNA_CONFIG || {};
const hasBackendConfig = Boolean(appConfig.supabaseUrl && appConfig.supabasePublishableKey);
const supabaseClient = hasBackendConfig && window.supabase
  ? window.supabase.createClient(appConfig.supabaseUrl, appConfig.supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

const pendingAuthStorageKey = "grannpojkarna.pending-auth.v1";
const pendingAuthLifetimeMs = 15 * 60 * 1000;
const authResendCooldownMs = 60 * 1000;

let currentUser = null;
let currentProfile = null;
let pendingJob = false;
let pendingJobAlert = false;
let pendingEditJobId = null;
let editingJobId = null;
let editingJobCoordinates = null;
let selectedJobImageFiles = [];
let existingJobImagePaths = [];
let removedJobImagePaths = [];
let pendingApplicationJobId = null;
let selectedApplicationJobId = null;
let roleHint = document.body.dataset.page === "jobs" ? "performer" : "customer";
let publicJobs = [];
let visiblePublicJobs = [];
let nearbyPublicJobs = [];
let jobFilterOrigin = null;
let jobFilterOriginLabel = "";
let jobsMap = null;
let jobsMapMarkers = [];
let jobsMapLoaded = false;
let jobsMapPendingJobs = [];
let jobsMapFallback = false;
let activeJobView = "list";
let ownJobs = [];
let assignedJobs = [];
let accountJobFilters = { performer: "active", owner: "active" };
let availablePerformers = [];
let selectedChatJobId = null;
let selectedChatOtherLabel = "Den andra personen";
let chatRefreshTimer = null;
let selectedDirectProfile = null;
let pendingDirectProfileId = null;
let pendingDirectFocusMessage = false;
let directMessageRefreshTimer = null;
let accountMessageConversations = [];
let selectedAccountConversationIndex = null;
let accountConversationRefreshTimer = null;
let savingsGoals = [];
let editingSavingsGoalId = null;
let jobAlerts = [];
let establishedProfileIds = new Set();
let completedEarningsJobs = [];
let reportTarget = null;
let notifications = [];
let notificationRefreshTimer = null;
let authResendTimer = null;
let authAutoSubmitTimer = null;
let authReady = false;

const profileFields = "id, display_name, phone, account_type, performer_enabled, bio, service_area, skills, role, avatar_path, savings_goal_sek, availability_status, available_until, email_job_alert_mode";

const byId = (id) => document.getElementById(id);
const isAccountPage = () => document.body.dataset.page === "account";

function hasPendingAccountAction() {
  return Boolean(pendingJob || pendingJobAlert || pendingEditJobId || pendingApplicationJobId || pendingDirectProfileId);
}

function handleAccountButton() {
  if (currentUser && currentProfile) {
    if (isAccountPage()) window.scrollTo({ top: 0, behavior: "smooth" });
    else window.location.href = "konto.html";
    return;
  }
  openAccountModal("customer");
}

function readPendingAuthFlow() {
  try {
    const raw = window.localStorage.getItem(pendingAuthStorageKey);
    if (!raw) return null;
    const state = JSON.parse(raw);
    const valid = state
      && typeof state.email === "string"
      && state.email.includes("@")
      && Number(state.expiresAt) > Date.now();
    if (!valid) {
      window.localStorage.removeItem(pendingAuthStorageKey);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function savePendingAuthFlow(email, sentAt = Date.now(), dismissed = false) {
  const state = {
    email: String(email || "").trim().toLowerCase(),
    sentAt,
    expiresAt: sentAt + pendingAuthLifetimeMs,
    dismissed
  };
  try {
    window.localStorage.setItem(pendingAuthStorageKey, JSON.stringify(state));
  } catch {
    // Inloggningen fungerar fortfarande om webbläsaren blockerar lokal lagring.
  }
  return state;
}

function setPendingAuthDismissed(dismissed) {
  const state = readPendingAuthFlow();
  if (!state) return;
  try {
    window.localStorage.setItem(pendingAuthStorageKey, JSON.stringify({ ...state, dismissed }));
  } catch {
    // Ingen åtgärd krävs om webbläsaren blockerar lokal lagring.
  }
}

function clearPendingAuthFlow() {
  if (authResendTimer) window.clearInterval(authResendTimer);
  authResendTimer = null;
  try {
    window.localStorage.removeItem(pendingAuthStorageKey);
  } catch {
    // Ingen åtgärd krävs om webbläsaren blockerar lokal lagring.
  }
}

function updateResendCodeState() {
  const button = byId("resendCodeBtn");
  const help = byId("resendCodeHelp");
  const state = readPendingAuthFlow();
  if (!button || !help || !state) return 0;
  const remainingSeconds = Math.max(0, Math.ceil((state.sentAt + authResendCooldownMs - Date.now()) / 1000));
  button.disabled = remainingSeconds > 0;
  button.textContent = remainingSeconds > 0 ? `Skicka ny kod (${remainingSeconds} s)` : "Skicka ny kod";
  help.textContent = remainingSeconds > 0
    ? "Koden kan fyllas i automatiskt. Du kan begära en ny när väntetiden är slut."
    : "Fick du ingen kod? Kontrollera skräpposten eller skicka en ny här.";
  return remainingSeconds;
}

function startResendCodeTimer() {
  if (authResendTimer) window.clearInterval(authResendTimer);
  authResendTimer = null;
  if (updateResendCodeState() <= 0) return;
  authResendTimer = window.setInterval(() => {
    if (updateResendCodeState() <= 0) {
      window.clearInterval(authResendTimer);
      authResendTimer = null;
    }
  }, 1000);
}

function restorePendingLogin(options = {}) {
  if (currentUser) return false;
  const state = readPendingAuthFlow();
  if (!state || (state.dismissed && !options.ignoreDismissed)) return false;
  if (options.openModal !== false) byId("accountModal")?.classList.add("show");
  showCodeStep(state.email, { persist: false });
  return true;
}

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

function showEmailStep(resetPending = false) {
  if (resetPending) clearPendingAuthFlow();
  hideAccountSteps();
  byId("authEmailStep")?.classList.remove("hidden");
  if (byId("accountTitle")) byId("accountTitle").textContent = "Logga in eller skapa konto";
  if (resetPending && byId("authCode")) byId("authCode").value = "";
  setNotice("authEmailNotice");
  setTimeout(() => byId("authEmail")?.focus(), 50);
}

function showCodeStep(email, options = {}) {
  if (options.persist !== false) savePendingAuthFlow(email);
  hideAccountSteps();
  byId("authCodeStep")?.classList.remove("hidden");
  if (byId("authEmail")) byId("authEmail").value = email;
  if (byId("codeEmail")) byId("codeEmail").textContent = email;
  if (byId("accountTitle")) byId("accountTitle").textContent = "Ange din kod";
  startResendCodeTimer();
  setTimeout(() => byId("authCode")?.focus(), 50);
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
  byId("accountModal")?.classList.add("show");
  hideAccountSteps();
  byId("performerStep")?.classList.remove("hidden");
  if (byId("accountTitle")) byId("accountTitle").textContent = "Din utförarprofil";
  if (byId("performerArea")) byId("performerArea").value = currentProfile.service_area || "";
  if (byId("performerSkills")) byId("performerSkills").value = (currentProfile.skills || []).join(", ");
  if (byId("performerBio")) byId("performerBio").value = currentProfile.bio || "";
  setNotice("performerNotice");
}

async function showAccountStep() {
  if (!isAccountPage()) {
    if (!hasPendingAccountAction()) window.location.href = "konto.html";
    return;
  }
  hideAccountSteps();
  byId("accountModal")?.classList.remove("show");
  byId("accountPageLoading")?.classList.add("hidden");
  byId("accountPageGuest")?.classList.add("hidden");
  byId("accountPageContent")?.classList.remove("hidden");
  if (byId("accountTitle")) byId("accountTitle").textContent = "Mitt konto";
  if (byId("accountName")) byId("accountName").textContent = currentProfile?.display_name || "Mitt konto";
  if (byId("accountEmail")) {
    byId("accountEmail").textContent = currentUser?.email || "";
    byId("accountEmail").title = currentUser?.email || "";
  }
  const accountType = currentProfile?.account_type === "company" ? "Företag" : "Privatperson";
  const capability = currentProfile?.performer_enabled ? "Beställare + utförare" : "Beställare";
  if (byId("accountRole")) byId("accountRole").textContent = `${accountType} · ${capability}`;
  byId("findJobsBtn")?.classList.toggle("hidden", !currentProfile?.performer_enabled);
  byId("enablePerformerBtn")?.classList.toggle("hidden", Boolean(currentProfile?.performer_enabled));
  byId("accountTabEarnings")?.classList.toggle("hidden", !currentProfile?.performer_enabled);
  updateProfilePanel();
  const requestedTab = window.location.hash.replace("#", "");
  const initialTab = ["jobs", "messages", "profile", "earnings"].includes(requestedTab) ? requestedTab : "jobs";
  showAccountTab(initialTab);
  await Promise.all([
    loadMyJobs(),
    initialTab === "messages" ? Promise.resolve() : loadAccountMessages(),
    currentProfile?.performer_enabled ? loadEarnings() : Promise.resolve(),
    loadJobAlerts()
  ]);
}

function openAccountModal(preselectedRole = "customer") {
  roleHint = preselectedRole;
  if (!hasBackendConfig) {
    byId("accountModal")?.classList.add("show");
    showEmailStep();
    setNotice("authEmailNotice", "Kontosystemet är ännu inte anslutet till databasen.", "error");
    return;
  }
  if (currentUser && currentProfile) {
    if (preselectedRole === "performer" && !currentProfile.performer_enabled) {
      byId("accountModal")?.classList.add("show");
      showPerformerStep();
    }
    else showAccountStep();
  } else if (currentUser) {
    byId("accountModal")?.classList.add("show");
    showProfileStep();
  } else {
    byId("accountModal")?.classList.add("show");
    setPendingAuthDismissed(false);
    if (!restorePendingLogin({ openModal: false, ignoreDismissed: true })) showEmailStep();
  }
}

function closeAccountModal() {
  closeAvailabilityMenu();
  closeJobChat();
  if (!currentUser && !byId("authCodeStep")?.classList.contains("hidden")) setPendingAuthDismissed(true);
  byId("accountModal")?.classList.remove("show");
}

async function sendLoginCode(event) {
  event?.preventDefault();
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
  savePendingAuthFlow(email);
  if (byId("authCode")) byId("authCode").value = "";
  showCodeStep(email, { persist: false });
}

async function resendLoginCode() {
  const state = readPendingAuthFlow();
  if (!state || updateResendCodeState() > 0 || !supabaseClient) return;
  const button = byId("resendCodeBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "Skickar…";
  }
  setNotice("authCodeNotice");
  const { error } = await supabaseClient.auth.signInWithOtp({
    email: state.email,
    options: { shouldCreateUser: true }
  });
  if (error) {
    savePendingAuthFlow(state.email);
    startResendCodeTimer();
    setNotice("authCodeNotice", "En ny kod kunde inte skickas ännu. Vänta en liten stund och försök igen.", "error");
    return;
  }
  savePendingAuthFlow(state.email);
  if (byId("authCode")) byId("authCode").value = "";
  startResendCodeTimer();
  setNotice("authCodeNotice", "En ny kod har skickats.", "success");
  setTimeout(() => byId("authCode")?.focus(), 50);
}

async function verifyLoginCode(event) {
  event?.preventDefault();
  if (byId("verifyCodeBtn")?.disabled) return;
  const email = readPendingAuthFlow()?.email || byId("authEmail")?.value.trim().toLowerCase() || "";
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
  clearPendingAuthFlow();
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
    messages: ["accountTabMessages", "accountMessagesPanel"],
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
  if (isAccountPage() && window.location.hash !== `#${requestedTab}`) {
    window.history.replaceState(null, "", `#${requestedTab}`);
  }
  if (requestedTab !== "messages" && accountConversationRefreshTimer) {
    window.clearInterval(accountConversationRefreshTimer);
    accountConversationRefreshTimer = null;
  }
  if (requestedTab === "messages") loadAccountMessages();
}

async function loadContactProfiles(profileIds) {
  const uniqueIds = [...new Set(profileIds.filter(Boolean))];
  const results = await Promise.all(uniqueIds.map(async (profileId) => {
    const { data } = await supabaseClient.rpc("get_contact_profile", { p_profile_id: profileId });
    return [profileId, data?.[0] || null];
  }));
  return new Map(results);
}

function messageConversationTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

function messagePreview(body, fallback) {
  const normalized = String(body || "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 92 ? `${normalized.slice(0, 89)}…` : normalized;
}

function messageReadReceipt(message) {
  if (!message.read_at) return "✓ Levererat";
  const time = new Date(message.read_at).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  return `✓✓ Läst ${time}`;
}

function renderChatMessage(message, otherLabel) {
  const isOwn = message.sender_id === currentUser.id;
  const timestamp = new Date(message.created_at).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `<div class="chat-message ${isOwn ? "is-own" : "is-other"}">
    <div>${escapeHtml(message.body)}</div>
    <span>${isOwn ? "Du" : escapeHtml(otherLabel)} · ${escapeHtml(timestamp)}</span>
    ${isOwn ? `<span class="message-receipt ${message.read_at ? "is-read" : ""}">${escapeHtml(messageReadReceipt(message))}</span>` : ""}
  </div>`;
}

async function markMessagesRead(tableName, messages) {
  const unreadIds = messages
    .filter((message) => message.sender_id !== currentUser.id && !message.read_at)
    .map((message) => message.id);
  if (!unreadIds.length) return messages;
  const readAt = new Date().toISOString();
  const { error } = await supabaseClient
    .from(tableName)
    .update({ read_at: readAt })
    .in("id", unreadIds);
  if (!error) {
    messages.forEach((message) => {
      if (unreadIds.includes(message.id)) message.read_at = readAt;
    });
  }
  return messages;
}

async function markConversationNotificationsRead(conversation) {
  if (!currentUser || !conversation) return;
  let query = supabaseClient
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", currentUser.id)
    .is("read_at", null);
  query = conversation.kind === "job"
    ? query.eq("type", "new_message").eq("job_id", conversation.jobId)
    : query.eq("type", "direct_message").eq("related_user_id", conversation.profileId);
  const { error } = await query;
  if (error) return;
  notifications.forEach((notification) => {
    const matches = conversation.kind === "job"
      ? notification.type === "new_message" && Number(notification.job_id) === Number(conversation.jobId)
      : notification.type === "direct_message" && notification.related_user_id === conversation.profileId;
    if (matches) notification.read_at ||= new Date().toISOString();
  });
  if (notifications.length) renderNotifications();
  else updateNotificationBadge();
}

function renderMessageConversation(conversation, index) {
  const avatar = conversation.profile?.avatar_path
    ? `<img src="${escapeHtml(avatarUrl(conversation.profile.avatar_path))}" alt="" />`
    : escapeHtml(initials(conversation.name));
  const context = conversation.kind === "job"
    ? `<span class="message-conversation-context">${escapeHtml(conversation.jobTitle)}</span>`
    : '<span class="message-conversation-context">Direktmeddelande</span>';
  const selectedClass = Number(index) === Number(selectedAccountConversationIndex) ? " is-selected" : "";
  return `<button class="message-conversation${selectedClass}" data-conversation-index="${index}" type="button" onclick="openAccountConversation(${index})">
    <span class="message-conversation-avatar" aria-hidden="true">${avatar}</span>
    <span class="message-conversation-body">
      <span class="message-conversation-head">
        <strong>${escapeHtml(conversation.name)}</strong>
        <time datetime="${escapeHtml(conversation.updatedAt || "")}">${escapeHtml(messageConversationTime(conversation.updatedAt))}</time>
      </span>
      ${context}
      <span class="message-conversation-preview">${escapeHtml(conversation.preview)}</span>
    </span>
    ${conversation.unreadCount ? `<span class="message-unread-count" aria-label="${conversation.unreadCount} olästa">${conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</span>` : ""}
    <span class="message-conversation-arrow" aria-hidden="true">›</span>
  </button>`;
}

function renderMessageGroup(title, description, conversations, emptyText) {
  const rows = conversations.map((conversation) => {
    const index = accountMessageConversations.indexOf(conversation);
    return renderMessageConversation(conversation, index);
  }).join("");
  return `<section class="message-group">
    <div class="message-group-head">
      <div><h4>${escapeHtml(title)}</h4><span>${escapeHtml(description)}</span></div>
      <span class="status-pill">${conversations.length}</span>
    </div>
    <div class="message-conversation-list">
      ${rows || `<div class="message-empty">${escapeHtml(emptyText)}</div>`}
    </div>
  </section>`;
}

async function loadAccountMessages() {
  const container = byId("accountMessagesList");
  if (!container || !supabaseClient || !currentUser) return;
  container.setAttribute("aria-busy", "true");
  container.innerHTML = '<div class="account-meta">Hämtar dina konversationer…</div>';
  const jobFields = "id, user_id, performer_id, title, category, status, updated_at";
  const [ownedResult, assignedResult, directResult] = await Promise.all([
    supabaseClient
      .from("jobs")
      .select(jobFields)
      .eq("user_id", currentUser.id)
      .in("status", ["accepted", "in_progress", "completed", "cancelled"])
      .order("updated_at", { ascending: false }),
    supabaseClient
      .from("jobs")
      .select(jobFields)
      .eq("performer_id", currentUser.id)
      .in("status", ["accepted", "in_progress", "completed", "cancelled"])
      .order("updated_at", { ascending: false }),
    supabaseClient
      .from("direct_messages")
      .select("id, sender_id, recipient_id, body, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(300)
  ]);

  const jobs = [...(ownedResult.data || []), ...(assignedResult.data || [])]
    .filter((job, index, all) => all.findIndex((candidate) => Number(candidate.id) === Number(job.id)) === index);
  const jobIds = jobs.map((job) => job.id);
  const jobMessagesResult = jobIds.length
    ? await supabaseClient
        .from("job_messages")
        .select("id, job_id, sender_id, body, read_at, created_at")
        .in("job_id", jobIds)
        .order("created_at", { ascending: false })
        .limit(500)
    : { data: [], error: null };

  if (ownedResult.error || assignedResult.error || directResult.error || jobMessagesResult.error) {
    container.removeAttribute("aria-busy");
    container.innerHTML = '<div class="notice error">Meddelandena kunde inte hämtas. Försök igen om en liten stund.</div>';
    return;
  }

  const latestJobMessage = new Map();
  const unreadJobMessages = new Map();
  (jobMessagesResult.data || []).forEach((message) => {
    if (!latestJobMessage.has(Number(message.job_id))) latestJobMessage.set(Number(message.job_id), message);
    if (message.sender_id !== currentUser.id && !message.read_at) {
      const jobId = Number(message.job_id);
      unreadJobMessages.set(jobId, (unreadJobMessages.get(jobId) || 0) + 1);
    }
  });

  const latestDirectMessage = new Map();
  const unreadDirectMessages = new Map();
  (directResult.data || []).forEach((message) => {
    const otherId = message.sender_id === currentUser.id ? message.recipient_id : message.sender_id;
    if (otherId && !latestDirectMessage.has(otherId)) latestDirectMessage.set(otherId, message);
    if (message.recipient_id === currentUser.id && !message.read_at && otherId) {
      unreadDirectMessages.set(otherId, (unreadDirectMessages.get(otherId) || 0) + 1);
    }
  });

  const jobOtherIds = jobs.map((job) => job.user_id === currentUser.id ? job.performer_id : job.user_id);
  const profileIds = [...jobOtherIds, ...latestDirectMessage.keys()];
  const profiles = await loadContactProfiles(profileIds);

  const jobConversations = jobs.map((job) => {
    const otherId = job.user_id === currentUser.id ? job.performer_id : job.user_id;
    const profile = profiles.get(otherId);
    const latest = latestJobMessage.get(Number(job.id));
    return {
      kind: "job",
      job,
      jobId: Number(job.id),
      jobTitle: job.title || job.category || "Jobb",
      profile,
      profileId: otherId,
      name: profile?.display_name || (job.user_id === currentUser.id ? "Utföraren" : "Beställaren"),
      preview: messagePreview(latest?.body, ["completed", "cancelled"].includes(job.status) ? "Jobbet är avslutat" : "Öppna chatten för att börja planera"),
      updatedAt: latest?.created_at || job.updated_at,
      unreadCount: unreadJobMessages.get(Number(job.id)) || 0
    };
  }).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  const directConversations = [...latestDirectMessage.entries()].map(([profileId, latest]) => {
    const profile = profiles.get(profileId);
    return {
      kind: "direct",
      profile,
      profileId,
      name: profile?.display_name || "Användare",
      preview: messagePreview(latest.body, "Öppna konversationen"),
      updatedAt: latest.created_at,
      unreadCount: unreadDirectMessages.get(profileId) || 0
    };
  }).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  const previous = accountMessageConversations[Number(selectedAccountConversationIndex)];
  const previousKey = previous ? `${previous.kind}:${previous.kind === "job" ? previous.jobId : previous.profileId}` : null;
  accountMessageConversations = [...jobConversations, ...directConversations];
  selectedAccountConversationIndex = previousKey
    ? accountMessageConversations.findIndex((conversation) => `${conversation.kind}:${conversation.kind === "job" ? conversation.jobId : conversation.profileId}` === previousKey)
    : accountMessageConversations.length ? 0 : null;
  if (selectedAccountConversationIndex < 0) selectedAccountConversationIndex = accountMessageConversations.length ? 0 : null;
  const unreadCount = accountMessageConversations.reduce((sum, conversation) => sum + Number(conversation.unreadCount || 0), 0);
  if (byId("accountMessageNavCount")) byId("accountMessageNavCount").textContent = String(unreadCount);
  container.removeAttribute("aria-busy");
  container.innerHTML = [
    renderMessageGroup("Jobbkonversationer", "Samtal grupperade efter uppdrag", jobConversations, "När ett jobb har fått en utförare visas chatten här."),
    renderMessageGroup("Direktmeddelanden", "Privata samtal utanför ett specifikt jobb", directConversations, "Dina direktmeddelanden till andra användare visas här.")
  ].join("");
  const messagesPanelVisible = isAccountPage() && !byId("accountMessagesPanel")?.classList.contains("hidden");
  if (messagesPanelVisible && selectedAccountConversationIndex !== null) await openAccountConversation(selectedAccountConversationIndex, { scroll: false });
  else if (messagesPanelVisible) renderEmptyAccountConversation();
}

function renderEmptyAccountConversation() {
  if (byId("accountConversationTitle")) byId("accountConversationTitle").textContent = "Välj en konversation";
  if (byId("accountConversationContext")) byId("accountConversationContext").textContent = "Dina meddelanden visas här.";
  if (byId("accountConversationMessages")) {
    byId("accountConversationMessages").innerHTML = '<div class="chat-empty"><strong>Ingen konversation vald</strong><span>Välj ett samtal i listan för att läsa och svara.</span></div>';
  }
  byId("accountConversationForm")?.classList.add("hidden");
  setNotice("accountConversationNotice");
}

async function loadAccountConversationMessages() {
  const conversation = accountMessageConversations[Number(selectedAccountConversationIndex)];
  const container = byId("accountConversationMessages");
  if (!conversation || !container || !currentUser) return;
  if (!container.children.length) container.innerHTML = '<div class="account-meta">Hämtar meddelanden…</div>';
  const result = conversation.kind === "job"
    ? await supabaseClient
        .from("job_messages")
        .select("id, sender_id, body, read_at, created_at")
        .eq("job_id", conversation.jobId)
        .order("created_at", { ascending: true })
    : await supabaseClient
        .from("direct_messages")
        .select("id, sender_id, recipient_id, body, read_at, created_at")
        .or(`and(sender_id.eq.${currentUser.id},recipient_id.eq.${conversation.profileId}),and(sender_id.eq.${conversation.profileId},recipient_id.eq.${currentUser.id})`)
        .order("created_at", { ascending: true });
  if (result.error) {
    container.innerHTML = '<div class="notice error">Konversationen kunde inte hämtas.</div>';
    return;
  }
  const messages = await markMessagesRead(conversation.kind === "job" ? "job_messages" : "direct_messages", result.data || []);
  await markConversationNotificationsRead(conversation);
  conversation.unreadCount = 0;
  const unreadCount = accountMessageConversations.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0);
  if (byId("accountMessageNavCount")) byId("accountMessageNavCount").textContent = String(unreadCount);
  const conversationButton = document.querySelector(`.message-conversation[data-conversation-index="${selectedAccountConversationIndex}"]`);
  conversationButton?.querySelector(".message-unread-count")?.remove();
  container.innerHTML = messages.length
    ? messages.map((message) => renderChatMessage(message, conversation.name)).join("")
    : `<div class="chat-empty"><strong>Inga meddelanden ännu</strong><span>${conversation.kind === "job" ? "Börja planera jobbet här." : "Skriv en kort fråga för att starta samtalet."}</span></div>`;
  container.scrollTop = container.scrollHeight;
}

async function sendAccountConversationMessage(event) {
  event.preventDefault();
  const conversation = accountMessageConversations[Number(selectedAccountConversationIndex)];
  const input = byId("accountConversationInput");
  const body = input?.value.trim() || "";
  if (!conversation || !body || !currentUser) return;
  setLoading("accountConversationSendBtn", true, "Skickar…", "Skicka");
  setNotice("accountConversationNotice");
  const result = conversation.kind === "job"
    ? await supabaseClient.from("job_messages").insert({ job_id: conversation.jobId, sender_id: currentUser.id, body })
    : await supabaseClient.rpc("send_direct_message", { p_recipient_id: conversation.profileId, p_body: body });
  setLoading("accountConversationSendBtn", false, "Skickar…", "Skicka");
  if (result.error) {
    setNotice("accountConversationNotice", "Meddelandet kunde inte skickas.", "error");
    return;
  }
  input.value = "";
  await loadAccountConversationMessages();
  input.focus();
}

async function openAccountConversation(index, options = {}) {
  const conversation = accountMessageConversations[Number(index)];
  if (!conversation) return;
  if (isAccountPage() && byId("accountConversationPane")) {
    selectedAccountConversationIndex = Number(index);
    document.querySelectorAll(".message-conversation").forEach((button) => {
      button.classList.toggle("is-selected", Number(button.dataset.conversationIndex) === selectedAccountConversationIndex);
    });
    if (byId("accountConversationTitle")) byId("accountConversationTitle").textContent = conversation.name;
    if (byId("accountConversationContext")) {
      byId("accountConversationContext").textContent = conversation.kind === "job"
        ? `Jobb: ${conversation.jobTitle}`
        : "Privat direktmeddelande";
    }
    const isClosed = conversation.kind === "job" && ["completed", "cancelled"].includes(conversation.job.status);
    byId("accountConversationForm")?.classList.toggle("hidden", isClosed);
    setNotice("accountConversationNotice", isClosed ? "Jobbet är avslutat. Konversationen är sparad men stängd för nya meddelanden." : "");
    if (byId("accountConversationMessages")) byId("accountConversationMessages").innerHTML = "";
    await loadAccountConversationMessages();
    if (accountConversationRefreshTimer) window.clearInterval(accountConversationRefreshTimer);
    accountConversationRefreshTimer = window.setInterval(loadAccountConversationMessages, 5000);
    if (options.scroll !== false && window.matchMedia("(max-width: 820px)").matches) {
      byId("accountConversationPane")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (!isClosed && options.focus) byId("accountConversationInput")?.focus();
    return;
  }
  if (conversation.kind === "job") {
    if (!findAccountJob(conversation.jobId)) {
      if (conversation.job.user_id === currentUser.id) ownJobs.push({ ...conversation.job, applications: [], review: null });
      else assignedJobs.push(conversation.job);
    }
    await openJobChat(conversation.jobId);
    return;
  }
  await openPerformerProfile(conversation.profileId, true);
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

function jobImageUrl(path) {
  if (!path || !supabaseClient) return "";
  const { data } = supabaseClient.storage.from("job-images").getPublicUrl(path);
  return data?.publicUrl || "";
}

async function loadEstablishedProfileBadges() {
  if (!supabaseClient) return;
  const { data, error } = await supabaseClient
    .from("profile_badges")
    .select("user_id")
    .eq("active", true);
  establishedProfileIds = error ? new Set() : new Set((data || []).map((item) => item.user_id));
}

function establishedProfileBadge(profileId) {
  return establishedProfileIds.has(profileId)
    ? '<span class="trust-badge" title="Minst fem slutförda jobb utan bekräftad anmärkning">✓ Beprövad profil</span>'
    : "";
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
    job_cancelled: "×",
    payout_ready: "kr",
    new_message: "💬",
    direct_message: "💬"
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
        <button class="notification-item ${notification.read_at ? "" : "is-unread"}" type="button" onclick="openNotification(${notification.id}, ${notification.job_id || "null"}, ${notification.related_user_id ? `'${notification.related_user_id}'` : "null"})">
          <span class="notification-icon" aria-hidden="true">${escapeHtml(notificationIcon(notification.type))}</span>
          <span class="notification-copy">
            <strong>${escapeHtml(notification.title)}</strong>
            <span>${escapeHtml(notification.body || "")}</span>
            <time datetime="${escapeHtml(notification.created_at)}">${escapeHtml(formatRelativeDate(notification.created_at))}</time>
          </span>
        </button>`).join("")
    : '<div class="notification-empty"><strong>Inga notiser ännu</strong><br><span>Här ser du nya meddelanden och vad som händer med dina jobb.</span></div>';
  byId("markAllNotificationsBtn")?.classList.toggle("hidden", !notifications.some((notification) => !notification.read_at));
  updateNotificationBadge();
}

async function loadNotifications() {
  if (!supabaseClient || !currentUser || !byId("notificationList")) return;
  const { data, error } = await supabaseClient
    .from("notifications")
    .select("id, type, title, body, job_id, related_user_id, read_at, created_at")
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

async function openNotification(notificationId, jobId, relatedUserId = null) {
  await markNotificationRead(notificationId);
  closeNotificationCenter();
  if (jobId) {
    openAccountModal();
    window.setTimeout(() => showAccountTab("jobs"), 100);
  } else if (relatedUserId) {
    await openPerformerProfile(relatedUserId, true);
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
  prepareNewJobForm();
  byId("modal").classList.add("show");
  renderJobModalPerformers();
  setNotice("jobNotice");
}

function closeModal() {
  byId("modal")?.classList.remove("show");
  window.setTimeout(prepareNewJobForm, 120);
}

function continuePendingAction() {
  if (pendingJobAlert && currentProfile) {
    pendingJobAlert = false;
    closeAccountModal();
    setTimeout(saveCurrentJobAlert, 120);
    return;
  }
  if (pendingDirectProfileId && currentProfile) {
    const profileId = pendingDirectProfileId;
    const focusMessage = pendingDirectFocusMessage;
    pendingDirectProfileId = null;
    pendingDirectFocusMessage = false;
    closeAccountModal();
    setTimeout(() => openPerformerProfile(profileId, focusMessage), 120);
    return;
  }
  if (pendingApplicationJobId && currentProfile?.performer_enabled) {
    const jobId = pendingApplicationJobId;
    pendingApplicationJobId = null;
    closeAccountModal();
    setTimeout(() => openApplicationModal(jobId), 120);
    return;
  }
  if (pendingEditJobId && currentProfile) {
    const jobId = pendingEditJobId;
    pendingEditJobId = null;
    closeAccountModal();
    setTimeout(() => openEditJob(jobId), 120);
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

function updateJobPriceTypeFields() {
  const priceType = byId("jobPriceType")?.value || "fixed";
  const label = byId("budgetLabel");
  const input = byId("jobBudget");
  const help = byId("jobBudgetHelp");
  if (!label || !input || !help) return;
  if (priceType === "hourly") {
    label.textContent = "Timpris";
    input.placeholder = "Exempel: 250 kr/tim";
    help.textContent = "Beloppet gäller per arbetad timme, inte för hela jobbet.";
  } else if (priceType === "quote") {
    label.textContent = "Ungefärlig budget";
    input.placeholder = "Exempel: 2 000 kr";
    help.textContent = "Utförare kan föreslå ett annat pris.";
  } else {
    label.textContent = "Fast totalpris";
    input.placeholder = "Exempel: 600 kr totalt";
    help.textContent = "Beloppet gäller för hela jobbet.";
  }
}

const jobCategoryTips = {
  "Flytt & bärhjälp": "Skriv vad som ska bäras, antal eller storlek, våning, hiss och om transport behövs.",
  "Trädgård": "Beskriv yta eller längd, vad som ska göras, om redskap finns och om avfall ska forslas bort.",
  "Montering & småfix": "Skriv vad som ska monteras eller lagas, modell eller mått och om verktyg eller delar finns.",
  "Målning": "Ange ungefärlig yta, antal rum, underlag, förarbete och om färg eller material finns.",
  "Rengöring": "Beskriv antal rum eller yta, vilken typ av städning och om material finns på plats.",
  "Bortforsling & transport": "Skriv vad som ska hämtas, ungefärlig mängd eller mått, trappor och avstånd.",
  "Djurpassning": "Berätta vilket djur, tider, behov, vanor och sådant utföraren måste känna till.",
  "Teknikhjälp": "Skriv vilken produkt eller tjänst det gäller, modell och vad som inte fungerar.",
  "Större projekt": "Beskriv omfattning, mått, önskat resultat, material och om behörighet krävs.",
  "Övrigt": "Beskriv vad som ska göras, ungefärlig omfattning och praktiska förutsättningar."
};

function updateJobCategoryTip() {
  const category = byId("jobCategory")?.value || "Övrigt";
  if (byId("categoryJobTip")) byId("categoryJobTip").textContent = jobCategoryTips[category] || jobCategoryTips.Övrigt;
  analyzeJobQuality();
}

function updateJobDateRangeVisibility() {
  const custom = byId("jobWhen")?.value === "custom";
  byId("jobDateRange")?.classList.toggle("hidden", !custom);
  if (byId("jobDateStart")) byId("jobDateStart").required = custom;
  analyzeJobQuality();
}

function formatShortDate(value) {
  if (!value) return "";
  return new Date(`${value}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

function timingPayload() {
  const choice = byId("jobWhen")?.value || "later";
  const start = choice === "custom" ? (byId("jobDateStart")?.value || null) : null;
  const end = choice === "custom" ? (byId("jobDateEnd")?.value || null) : null;
  const labels = { today: "Idag", tomorrow: "Imorgon", week: "Den här veckan", later: "Kom överens senare" };
  const timing = choice === "custom"
    ? end && end !== start ? `${formatShortDate(start)}–${formatShortDate(end)}` : formatShortDate(start)
    : labels[choice] || "Kom överens senare";
  return { choice, timing, dateStart: start, dateEnd: end };
}

function analyzeJobQuality() {
  const title = byId("jobTitle")?.value.trim() || "";
  const description = byId("description")?.value.trim() || "";
  const location = byId("jobLocation")?.value.trim() || "";
  const budget = parseBudget(byId("jobBudget")?.value || "");
  const timing = timingPayload();
  const validDateRange = timing.choice !== "custom" || (Boolean(timing.dateStart) && (!timing.dateEnd || timing.dateEnd >= timing.dateStart));
  const detailSignal = /\d|meter|rum|våning|hiss|redskap|verktyg|material|modell|yta|storlek|antal/i.test(description);
  const checks = [
    { ok: title.length >= 10, weight: 15, tip: "Gör rubriken lite tydligare, gärna minst 10 tecken." },
    { ok: description.length >= 80, weight: 30, tip: `Beskriv jobbet noggrannare – ${Math.max(0, 80 - description.length)} tecken återstår.` },
    { ok: detailSignal || description.length >= 160, weight: 15, tip: "Lägg till omfattning, mått, antal eller praktiska förutsättningar." },
    { ok: location.length >= 2, weight: 15, tip: "Ange ort eller område, men vänta med exakt portkod." },
    { ok: validDateRange, weight: 10, tip: "Kontrollera att datumintervallet börjar och slutar i rätt ordning." },
    { ok: Boolean(budget), weight: 10, tip: "Ange budget eller ungefärlig ersättning." },
    { ok: existingJobImagePaths.length + selectedJobImageFiles.length > 0, weight: 5, tip: "En bild är frivillig men gör jobbet lättare att bedöma." }
  ];
  const score = checks.reduce((sum, check) => sum + (check.ok ? check.weight : 0), 0);
  const missing = checks.filter((check) => !check.ok).map((check) => check.tip);
  const label = score >= 85 ? "Mycket tydlig" : score >= 65 ? "Bra" : score >= 40 ? "På väg" : "Kom igång";
  if (byId("jobQualityLabel")) byId("jobQualityLabel").textContent = `Annonsens kvalitet: ${label}`;
  if (byId("jobQualityScore")) byId("jobQualityScore").textContent = `${score}%`;
  if (byId("jobQualityBar")) byId("jobQualityBar").style.width = `${score}%`;
  if (byId("jobQualityTips")) byId("jobQualityTips").innerHTML = (missing.length ? missing.slice(0, 3) : ["Bra jobbat – annonsen innehåller det viktigaste."])
    .map((tip) => `<li>${escapeHtml(tip)}</li>`).join("");
  return { score, descriptionReady: description.length >= 80, dateReady: validDateRange };
}

function renderJobImagePreview() {
  const container = byId("jobImagePreview");
  if (!container) return;
  const existing = existingJobImagePaths.map((path, index) => ({ src: jobImageUrl(path), index, kind: "existing" }));
  const selected = selectedJobImageFiles.map((file, index) => ({ src: URL.createObjectURL(file), index, kind: "selected" }));
  container.innerHTML = [...existing, ...selected].map((image) => `<div class="job-image-thumb"><img src="${escapeHtml(image.src)}" alt="Förhandsvisning av jobbild" /><button type="button" onclick="removeJobImage('${image.kind}', ${image.index})" aria-label="Ta bort bilden">×</button></div>`).join("");
  analyzeJobQuality();
}

function removeJobImage(kind, index) {
  if (kind === "existing") {
    const [path] = existingJobImagePaths.splice(index, 1);
    if (path) removedJobImagePaths.push(path);
  } else {
    selectedJobImageFiles.splice(index, 1);
  }
  if (byId("jobImages")) byId("jobImages").value = "";
  renderJobImagePreview();
}

function handleJobImages(event) {
  const incoming = Array.from(event.target.files || []);
  const valid = incoming.filter((file) => ["image/jpeg", "image/png", "image/webp"].includes(file.type) && file.size <= 5 * 1024 * 1024);
  const room = Math.max(0, 5 - existingJobImagePaths.length - selectedJobImageFiles.length);
  selectedJobImageFiles.push(...valid.slice(0, room));
  if (valid.length !== incoming.length || incoming.length > room) {
    setNotice("jobNotice", "Några bilder hoppades över. Välj högst 5 JPG-, PNG- eller WebP-bilder under 5 MB.", "error");
  } else {
    setNotice("jobNotice");
  }
  event.target.value = "";
  renderJobImagePreview();
}

async function uploadJobImages(files) {
  const uploaded = [];
  for (const file of files) {
    const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[file.type] || "jpg";
    const path = `${currentUser.id}/${crypto.randomUUID()}.${extension}`;
    const { error } = await supabaseClient.storage.from("job-images").upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
    if (error) {
      if (uploaded.length) await supabaseClient.storage.from("job-images").remove(uploaded);
      throw error;
    }
    uploaded.push(path);
  }
  return uploaded;
}

function renderJobImages(paths = []) {
  const images = (paths || []).filter(Boolean).slice(0, 5);
  if (!images.length) return "";
  const visible = images.slice(0, 3);
  return `<div class="job-card-images ${images.length === 1 ? "is-single" : ""}">${visible.map((path) => `<img src="${escapeHtml(jobImageUrl(path))}" alt="Bild från jobbannonsen" loading="lazy" />`).join("")}${images.length > 3 ? `<div class="job-card-image-more">+${images.length - 3}</div>` : ""}</div>`;
}

function prepareNewJobForm() {
  editingJobId = null;
  editingJobCoordinates = null;
  selectedJobImageFiles = [];
  existingJobImagePaths = [];
  removedJobImagePaths = [];
  byId("jobForm")?.reset();
  if (byId("modalTitle")) byId("modalTitle").textContent = "Lägg upp ett jobb";
  if (byId("submitBtn")) byId("submitBtn").textContent = "Publicera jobb";
  updateJobPriceTypeFields();
  updateJobDateRangeVisibility();
  updateJobCategoryTip();
  renderJobImagePreview();
  setNotice("jobNotice");
}

async function openEditJob(jobId) {
  if (!currentUser || !currentProfile) {
    pendingEditJobId = Number(jobId);
    openAccountModal("customer");
    return;
  }
  if (!byId("modal")) {
    window.location.href = `index.html?editJob=${encodeURIComponent(jobId)}`;
    return;
  }
  let job = ownJobs.find((item) => Number(item.id) === Number(jobId));
  if (!job) {
    const { data, error } = await supabaseClient
      .from("jobs")
      .select("id, user_id, title, description, location, latitude, longitude, timing, date_start, date_end, image_paths, budget_sek, price_type, category, status")
      .eq("id", jobId)
      .eq("user_id", currentUser.id)
      .maybeSingle();
    if (error) return;
    job = data;
  }
  if (!job || job.status !== "open" || job.user_id !== currentUser.id) {
    setNotice("accountNotice", "Endast egna öppna jobb kan redigeras.", "error");
    return;
  }
  editingJobId = Number(job.id);
  editingJobCoordinates = job.latitude !== null && job.latitude !== undefined && job.longitude !== null && job.longitude !== undefined
    && Number.isFinite(Number(job.latitude)) && Number.isFinite(Number(job.longitude))
    ? { latitude: Number(job.latitude), longitude: Number(job.longitude) }
    : null;
  if (byId("jobTitle")) byId("jobTitle").value = job.title || "";
  if (byId("description")) byId("description").value = job.description || "";
  if (byId("jobLocation")) byId("jobLocation").value = job.location || "";
  if (byId("jobWhen")) byId("jobWhen").value = job.date_start ? "custom" : ({ Idag: "today", Imorgon: "tomorrow", "Den här veckan": "week" })[job.timing] || "later";
  if (byId("jobDateStart")) byId("jobDateStart").value = job.date_start || "";
  if (byId("jobDateEnd")) byId("jobDateEnd").value = job.date_end || "";
  if (byId("jobBudget")) byId("jobBudget").value = job.budget_sek || "";
  if (byId("jobPriceType")) byId("jobPriceType").value = job.price_type || "fixed";
  if (byId("jobCategory")) byId("jobCategory").value = job.category || "Övrigt";
  if (byId("modalTitle")) byId("modalTitle").textContent = "Redigera jobb";
  if (byId("submitBtn")) byId("submitBtn").textContent = "Spara ändringar";
  selectedJobImageFiles = [];
  existingJobImagePaths = [...(job.image_paths || [])];
  removedJobImagePaths = [];
  updateJobPriceTypeFields();
  updateJobDateRangeVisibility();
  updateJobCategoryTip();
  renderJobImagePreview();
  setNotice("jobNotice", "Du kan redigera jobbet så länge ingen utförare har valts.");
  closeAccountModal();
  byId("modal")?.classList.add("show");
  renderJobModalPerformers();
}

async function submitJob(event) {
  event.preventDefault();
  if (!currentUser || !currentProfile) {
    closeModal();
    pendingJob = true;
    openAccountModal("customer");
    return;
  }
  const schedule = timingPayload();
  const quality = analyzeJobQuality();
  const payload = {
    user_id: currentUser.id,
    title: byId("jobTitle").value.trim(),
    description: byId("description").value.trim(),
    location: byId("jobLocation").value.trim(),
    timing: schedule.timing,
    date_start: schedule.dateStart,
    date_end: schedule.dateEnd,
    budget_sek: parseBudget(byId("jobBudget").value),
    price_type: byId("jobPriceType").value,
    category: byId("jobCategory").value
  };
  if (payload.title.length < 4 || !quality.descriptionReady || !quality.dateReady || !payload.location || !payload.budget_sek) {
    setNotice("jobNotice", "Kontrollera rubrik, en noggrann beskrivning, plats, datum och budget.", "error");
    return;
  }
  const isEditing = Boolean(editingJobId);
  setLoading("submitBtn", true, "Hittar området…", isEditing ? "Spara ändringar" : "Publicera jobb");
  const coordinates = await geocodeArea(payload.location) || editingJobCoordinates;
  payload.latitude = coordinates?.latitude ?? null;
  payload.longitude = coordinates?.longitude ?? null;
  setLoading("submitBtn", true, isEditing ? "Sparar…" : "Publicerar…", isEditing ? "Spara ändringar" : "Publicera jobb");
  let uploadedPaths = [];
  try {
    uploadedPaths = await uploadJobImages(selectedJobImageFiles);
  } catch {
    setLoading("submitBtn", false, isEditing ? "Sparar…" : "Publicerar…", isEditing ? "Spara ändringar" : "Publicera jobb");
    setNotice("jobNotice", "Bilderna kunde inte laddas upp. Försök igen eller ta bort dem.", "error");
    return;
  }
  const imagePaths = [...existingJobImagePaths, ...uploadedPaths].slice(0, 5);
  const result = isEditing
    ? await supabaseClient.rpc("edit_my_open_job", {
        p_job_id: editingJobId,
        p_title: payload.title,
        p_description: payload.description,
        p_location: payload.location,
        p_timing: payload.timing,
        p_budget_sek: payload.budget_sek,
        p_price_type: payload.price_type,
        p_category: payload.category,
        p_date_start: payload.date_start,
        p_date_end: payload.date_end,
        p_image_paths: imagePaths,
        p_latitude: payload.latitude,
        p_longitude: payload.longitude
      })
    : await supabaseClient.from("jobs").insert({ ...payload, image_paths: imagePaths }).select("id").single();
  const { data, error } = result;
  setLoading("submitBtn", false, isEditing ? "Sparar…" : "Publicerar…", isEditing ? "Spara ändringar" : "Publicera jobb");
  if (error) {
    if (uploadedPaths.length) await supabaseClient.storage.from("job-images").remove(uploadedPaths);
    setNotice("jobNotice", isEditing ? "Ändringarna kunde inte sparas. Jobbet kan ha accepterats under tiden." : "Jobbet kunde inte publiceras. Kontrollera att databasuppdateringen är körd.", "error");
    return;
  }
  if (removedJobImagePaths.length) await supabaseClient.storage.from("job-images").remove(removedJobImagePaths);
  if (isEditing) {
    editingJobId = null;
    editingJobCoordinates = null;
    setNotice("jobNotice", "Ändringarna är sparade.", "success");
    setTimeout(() => {
      closeModal();
      openAccountModal();
    }, 700);
    return;
  }
  if (data?.id) {
    supabaseClient.functions.invoke("send-new-job-alerts", { body: { job_id: data.id } }).catch(() => {});
  }
  byId("jobForm").reset();
  setNotice("jobNotice", "Jobbet är publicerat! Du skickas till jobblistan.", "success");
  setTimeout(() => { window.location.href = "jobb.html"; }, 900);
}

async function loadMyJobs() {
  const container = byId("myJobs");
  if (!container || !supabaseClient || !currentUser) return;
  container.innerHTML = '<div class="account-meta">Hämtar dina jobb och uppdrag…</div>';
  const jobFields = "id, user_id, title, description, location, latitude, longitude, timing, date_start, date_end, image_paths, budget_sek, price_type, category, status, created_at, updated_at, performer_id, agreed_price_sek, accepted_at, started_at, completed_at, cancelled_at, cancelled_by, cancellation_reason";
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
          .in("status", ["accepted", "in_progress", "completed", "cancelled"])
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
  renderMyJobs();
}

function setAccountJobFilter(relationship, filter) {
  if (!Object.hasOwn(accountJobFilters, relationship) || !["active", "completed"].includes(filter)) return;
  accountJobFilters[relationship] = filter;
  renderMyJobs();
}

function renderAccountJobGroup(title, description, jobs, relationship) {
  const activeJobs = jobs.filter((job) => !["completed", "cancelled"].includes(job.status));
  const completedJobs = jobs.filter((job) => ["completed", "cancelled"].includes(job.status));
  const filter = accountJobFilters[relationship] || "active";
  const visibleJobs = filter === "completed" ? completedJobs : activeJobs;
  const emptyText = filter === "completed"
    ? relationship === "owner"
      ? "Här visas jobb som är slutförda eller avslutade."
      : "Du har inga slutförda uppdrag ännu."
    : relationship === "owner"
      ? "Du har inga aktiva upplagda jobb just nu."
      : "Du har inget accepterat eller pågående uppdrag just nu.";
  return `<section class="account-job-group">
    <div class="account-job-group-head">
      <div><h4>${escapeHtml(title)}</h4><span>${escapeHtml(description)}</span></div>
      <span class="status-pill">${jobs.length}</span>
    </div>
    <div class="job-filter-tabs" role="tablist" aria-label="Filtrera ${escapeHtml(title.toLowerCase())}">
      <button class="job-filter-tab ${filter === "active" ? "is-active" : ""}" type="button" role="tab" aria-selected="${filter === "active"}" onclick="setAccountJobFilter('${relationship}', 'active')">Aktiva jobb <span>${activeJobs.length}</span></button>
      <button class="job-filter-tab ${filter === "completed" ? "is-active" : ""}" type="button" role="tab" aria-selected="${filter === "completed"}" onclick="setAccountJobFilter('${relationship}', 'completed')">Slutförda jobb <span>${completedJobs.length}</span></button>
    </div>
    <div class="account-job-filter-content">
      ${visibleJobs.length
        ? visibleJobs.map((job) => renderAccountJob(job, relationship)).join("")
        : `<div class="notice">${escapeHtml(emptyText)}</div>`}
    </div>
  </section>`;
}

function renderMyJobs() {
  const container = byId("myJobs");
  if (!container) return;
  const assignedSection = currentProfile?.performer_enabled
    ? renderAccountJobGroup("Jobb jag utför", "Accepterade, pågående och slutförda uppdrag", assignedJobs, "performer")
    : "";
  const ownedSection = renderAccountJobGroup("Jobb jag lagt upp", "Dina förfrågningar och valda utförare", ownJobs, "owner");
  container.innerHTML = `${assignedSection}${ownedSection}`;
}

function renderAccountJob(job, relationship) {
  const isOwner = relationship === "owner";
  const canChat = ["accepted", "in_progress", "completed", "cancelled"].includes(job.status);
  const statusHelp = ({
    open: "Väntar på intresseanmälningar",
    accepted: "Jobbet är taget – använd chatten för att planera jobbet",
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
      ${renderJobImages(job.image_paths)}
      <p>${escapeHtml(job.description)}</p>
      ${renderJobProgress(job.status)}
      ${["accepted", "in_progress", "completed"].includes(job.status) ? `<div class="job-agreement"><div><span>Överenskommen ersättning</span><strong>${job.agreed_price_sek ? `${formatCurrency(job.agreed_price_sek)}${job.price_type === "hourly" ? "/tim" : ""}` : formatPrice(job)}</strong></div><div><span>När</span><strong>${escapeHtml(job.timing)}</strong></div><div><span>Plats</span><strong>${escapeHtml(job.location)}</strong></div></div>` : ""}
      ${statusHelp ? `<div class="job-status-help">${escapeHtml(statusHelp)}</div>` : ""}
      ${job.status === "cancelled" && job.cancellation_reason ? `<div class="notice">Avslutat: ${escapeHtml(job.cancellation_reason)}</div>` : ""}
      <div class="job-row-footer">
        <strong>${job.agreed_price_sek ? `${formatCurrency(job.agreed_price_sek)}${job.price_type === "hourly" ? "/tim" : ""} överenskommet` : formatPrice(job)}</strong>
        <div class="account-actions">
          ${canChat ? `<button class="btn btn-light btn-small" type="button" onclick="openJobChat(${job.id})">Öppna chatt</button>` : ""}
          ${job.status === "accepted" ? `<button class="btn btn-primary btn-small" id="startJobBtn-${job.id}" type="button" onclick="startJob(${job.id})">Markera som pågående</button>` : ""}
          ${isOwner && job.status === "in_progress" ? `<button class="btn btn-primary btn-small" id="completeJobBtn-${job.id}" type="button" onclick="markJobCompleted(${job.id})">Bekräfta som klart</button>` : ""}
          ${isOwner && job.status === "open" ? `<button class="btn btn-light btn-small" id="editJobBtn-${job.id}" type="button" onclick="openEditJob(${job.id})">Redigera jobb</button>` : ""}
          ${["accepted", "in_progress"].includes(job.status) ? `<button class="btn btn-danger btn-small" id="cancelJobBtn-${job.id}" type="button" onclick="cancelJob(${job.id})">Avbryt jobb</button>` : ""}
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
      <h5>${job.status !== "open" ? "Utförare" : `Intresseanmälningar (${job.applications.length})`}</h5>
      ${visibleApplications.map((application) => {
        const applicationPrice = Number(application.proposed_price_sek || job.budget_sek);
        const isCounterOffer = Boolean(application.proposed_price_sek) && applicationPrice !== Number(job.budget_sek);
        const proposedPrice = `${isCounterOffer ? "Motbud" : job.status === "open" ? "Accepterar priset" : "Tog jobbet för"}: ${formatCurrency(applicationPrice)}${job.price_type === "hourly" ? "/tim" : ""}`;
        const rating = Number(application.average_rating || 0);
        const ratingCount = Number(application.review_count || 0);
        return `
          <div class="application-card">
            <div class="application-avatar">${application.avatar_path ? `<img src="${escapeHtml(avatarUrl(application.avatar_path))}" alt="" />` : escapeHtml(initials(application.display_name))}</div>
            <div>
              <h6><button class="profile-link-button" type="button" onclick="openPerformerProfile('${application.performer_id}')">${escapeHtml(application.display_name || "Utförare")}</button></h6>
              ${establishedProfileBadge(application.performer_id)}
              ${application.availability_status ? `<span class="availability-badge"><span aria-hidden="true"></span>${availabilityLabel(application.availability_status)}</span>` : ""}
              <div class="rating-line">${ratingCount ? `${rating.toFixed(1).replace(".", ",")} ★ · ${ratingCount} ${ratingCount === 1 ? "betyg" : "betyg"}` : "Ny utförare · inga betyg ännu"}</div>
              ${application.bio ? `<p>${escapeHtml(application.bio)}</p>` : ""}
              <div class="account-meta">${escapeHtml(application.service_area || "Område saknas")} · ${escapeHtml(proposedPrice)}</div>
              <p>${escapeHtml(application.message)}</p>
            </div>
            <div class="application-actions">
              ${job.status === "open" && application.status === "pending" ? `<button class="btn btn-primary btn-small" type="button" onclick="acceptApplication(${application.application_id}, ${job.id})">Acceptera motbud</button>` : `<span class="status-pill">${application.status === "accepted" ? "Accepterad" : "Ej vald"}</span>`}
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
  const promptText = job.price_type === "hourly"
    ? "Bekräfta överenskommet timpris i kronor per timme:"
    : "Bekräfta överenskommet totalpris i kronor:";
  const enteredPrice = window.prompt(promptText, suggestedPrice);
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

async function cancelJob(jobId) {
  const reason = window.prompt("Varför behöver jobbet avbrytas? Skriv en kort anledning som den andra personen kan förstå.");
  if (reason === null) return;
  const normalized = reason.trim();
  if (normalized.length < 3) {
    setNotice("accountNotice", "Skriv en kort anledning till att jobbet avbryts.", "error");
    return;
  }
  if (!window.confirm("Avbryt jobbet? Den andra personen får en tydlig status och chatten sparas.")) return;
  setLoading(`cancelJobBtn-${jobId}`, true, "Avbryter…", "Avbryt jobb");
  const { error } = await supabaseClient.rpc("cancel_job", { p_job_id: jobId, p_reason: normalized });
  if (error) {
    setLoading(`cancelJobBtn-${jobId}`, false, "Avbryter…", "Avbryt jobb");
    setNotice("accountNotice", "Jobbet kunde inte avbrytas. Försök igen.", "error");
    return;
  }
  closeJobChat();
  setNotice("accountNotice", "Jobbet har avbrutits och anledningen har sparats.", "success");
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
  const job = ownJobs.find((item) => Number(item.id) === Number(jobId));
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
  if (job?.image_paths?.length) await supabaseClient.storage.from("job-images").remove(job.image_paths);
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
  if (!job || !["accepted", "in_progress", "completed", "cancelled"].includes(job.status)) return;
  selectedChatJobId = Number(jobId);
  const otherUserId = job.user_id === currentUser.id ? job.performer_id : job.user_id;
  const fallbackLabel = job.user_id === currentUser.id ? "Utföraren" : "Beställaren";
  selectedChatOtherLabel = fallbackLabel;
  if (otherUserId) {
    const { data: otherProfile } = await supabaseClient.rpc("get_contact_profile", { p_profile_id: otherUserId });
    selectedChatOtherLabel = otherProfile?.[0]?.display_name || fallbackLabel;
  }
  if (byId("jobChatTitle")) byId("jobChatTitle").textContent = job.title || job.category || "Jobb";
  if (byId("jobChatParticipant")) byId("jobChatParticipant").textContent = `Chatt med ${selectedChatOtherLabel}`;
  const isClosed = ["completed", "cancelled"].includes(job.status);
  byId("jobChatForm")?.classList.toggle("hidden", isClosed);
  setNotice("jobChatNotice", isClosed ? "Jobbet är avslutat. Chatten är sparad men stängd för nya meddelanden." : "");
  byId("jobChatModal")?.classList.add("show");
  await loadJobMessages();
  if (chatRefreshTimer) window.clearInterval(chatRefreshTimer);
  chatRefreshTimer = window.setInterval(loadJobMessages, 5000);
  if (!isClosed) setTimeout(() => byId("jobChatInput")?.focus(), 80);
}

function closeJobChat() {
  if (chatRefreshTimer) window.clearInterval(chatRefreshTimer);
  chatRefreshTimer = null;
  selectedChatJobId = null;
  selectedChatOtherLabel = "Den andra personen";
  byId("jobChatModal")?.classList.remove("show");
  if (byId("jobChatMessages")) byId("jobChatMessages").innerHTML = "";
  if (byId("jobChatInput")) byId("jobChatInput").value = "";
  if (byId("jobChatParticipant")) byId("jobChatParticipant").textContent = "";
  setNotice("jobChatNotice");
}

function renderPublicProfile(profile) {
  const container = byId("publicProfileContent");
  if (!container || !profile) return;
  const rating = Number(profile.average_rating || 0);
  const reviewCount = Number(profile.review_count || 0);
  const skills = profile.skills || [];
  const status = activeAvailability(profile);
  if (byId("publicProfileEyebrow")) byId("publicProfileEyebrow").textContent = profile.performer_enabled ? "Utförarprofil" : "Kontaktprofil";
  if (byId("publicProfileTitle")) byId("publicProfileTitle").textContent = profile.display_name || "Profil";
  container.innerHTML = `
    <div class="public-profile-hero">
      <div class="public-profile-avatar">${profile.avatar_path ? `<img src="${escapeHtml(avatarUrl(profile.avatar_path))}" alt="" />` : escapeHtml(initials(profile.display_name))}</div>
      <div class="public-profile-summary">
        ${status !== "unavailable" ? `<span class="availability-badge"><span aria-hidden="true"></span>${availabilityLabel(status)}</span>` : ""}
        <h4>${escapeHtml(profile.display_name || "Utförare")}</h4>
        ${establishedProfileBadge(profile.id)}
        <div class="rating-line">${reviewCount ? `${rating.toFixed(1).replace(".", ",")} ★ · ${reviewCount} betyg` : "Inga betyg ännu"}</div>
      </div>
    </div>
    <div class="public-profile-facts">
      <span>📍 ${escapeHtml(profile.service_area || "Område ej angivet")}</span>
      ${profile.performer_enabled ? `<span>✓ ${Number(profile.completed_jobs || 0)} utförda jobb</span>` : ""}
    </div>
    <p class="public-profile-bio">${escapeHtml(profile.bio || "Ingen presentation har lagts till ännu.")}</p>
    ${skills.length ? `<div class="skill-list">${skills.map((skill) => `<span>${escapeHtml(skill)}</span>`).join("")}</div>` : ""}
    ${currentUser?.id === profile.id ? "" : `<button class="link-button danger-link report-link" type="button" onclick="openSafetyReport('profile', '${profile.id}')">Anmäl profilen</button>`}`;
}

async function openPerformerProfile(profileId, focusMessage = false) {
  if (!profileId || !supabaseClient || !byId("performerProfileModal")) return;
  const cachedProfile = availablePerformers.find((profile) => profile.id === profileId) || null;
  selectedDirectProfile = cachedProfile;
  byId("performerProfileModal").classList.add("show");
  if (cachedProfile) renderPublicProfile(cachedProfile);
  else if (byId("publicProfileContent")) byId("publicProfileContent").innerHTML = '<div class="account-meta">Hämtar profilen…</div>';

  const { data, error } = await supabaseClient.rpc("get_contact_profile", { p_profile_id: profileId });
  const profile = data?.[0] || cachedProfile;
  if (error || !profile) {
    if (byId("publicProfileContent")) byId("publicProfileContent").innerHTML = '<div class="notice error">Profilen kunde inte hämtas.</div>';
    byId("directMessagePanel")?.classList.add("hidden");
    return;
  }
  selectedDirectProfile = profile;
  renderPublicProfile(profile);
  const isOwnProfile = currentUser?.id === profile.id;
  byId("directMessagePanel")?.classList.toggle("hidden", isOwnProfile);
  if (isOwnProfile) return;
  if (byId("directMessageHeading")) byId("directMessageHeading").textContent = `Skicka meddelande till ${profile.display_name || "utföraren"}`;
  if (byId("directMessageIntro")) byId("directMessageIntro").textContent = profile.performer_enabled
    ? "Fråga om tillgänglighet eller berätta kort vad du behöver hjälp med."
    : "Fortsätt er privata konversation här.";
  setNotice("directMessageNotice");

  if (!currentUser) {
    byId("directMessageForm")?.classList.add("hidden");
    if (byId("directMessageMessages")) {
      byId("directMessageMessages").innerHTML = `<div class="chat-empty"><strong>Logga in för att skriva</strong><span>Ditt meddelande blir privat mellan er.</span><button class="btn btn-primary btn-small" type="button" onclick="beginDirectMessage('${profile.id}')">Logga in</button></div>`;
    }
    return;
  }

  byId("directMessageForm")?.classList.remove("hidden");
  await loadDirectMessages();
  if (directMessageRefreshTimer) window.clearInterval(directMessageRefreshTimer);
  directMessageRefreshTimer = window.setInterval(loadDirectMessages, 5000);
  if (focusMessage) setTimeout(() => byId("directMessageInput")?.focus(), 80);
}

function beginDirectMessage(profileId) {
  if (!currentUser || !currentProfile) {
    pendingDirectProfileId = profileId;
    pendingDirectFocusMessage = true;
    closePerformerProfile();
    openAccountModal("customer");
    return;
  }
  openPerformerProfile(profileId, true);
}

function closePerformerProfile() {
  if (directMessageRefreshTimer) window.clearInterval(directMessageRefreshTimer);
  directMessageRefreshTimer = null;
  selectedDirectProfile = null;
  byId("performerProfileModal")?.classList.remove("show");
  byId("directMessagePanel")?.classList.remove("hidden");
  byId("directMessageForm")?.classList.remove("hidden");
  if (byId("directMessageMessages")) byId("directMessageMessages").innerHTML = "";
  if (byId("directMessageInput")) byId("directMessageInput").value = "";
  setNotice("directMessageNotice");
}

async function loadDirectMessages() {
  const container = byId("directMessageMessages");
  if (!container || !currentUser || !selectedDirectProfile) return;
  if (!container.children.length) container.innerHTML = '<div class="account-meta">Hämtar meddelanden…</div>';
  const otherId = selectedDirectProfile.id;
  const { data, error } = await supabaseClient
    .from("direct_messages")
    .select("id, sender_id, recipient_id, body, read_at, created_at")
    .or(`and(sender_id.eq.${currentUser.id},recipient_id.eq.${otherId}),and(sender_id.eq.${otherId},recipient_id.eq.${currentUser.id})`)
    .order("created_at", { ascending: true });
  if (error) {
    container.innerHTML = '<div class="notice error">Meddelandena kunde inte hämtas. Databasuppdateringen kan saknas.</div>';
    return;
  }
  const messages = await markMessagesRead("direct_messages", data || []);
  await markConversationNotificationsRead({ kind: "direct", profileId: otherId });
  container.innerHTML = messages.length
    ? messages.map((message) => renderChatMessage(message, selectedDirectProfile.display_name || "Den andra personen")).join("")
    : '<div class="chat-empty"><strong>Inga meddelanden ännu</strong><span>Skriv en kort fråga för att ta första kontakten.</span></div>';
  container.scrollTop = container.scrollHeight;
}

async function sendDirectMessage(event) {
  event.preventDefault();
  if (!currentUser || !selectedDirectProfile || currentUser.id === selectedDirectProfile.id) return;
  const input = byId("directMessageInput");
  const body = input?.value.trim() || "";
  if (!body) return;
  setLoading("directMessageSendBtn", true, "Skickar…", "Skicka");
  setNotice("directMessageNotice");
  const { error } = await supabaseClient.rpc("send_direct_message", {
    p_recipient_id: selectedDirectProfile.id,
    p_body: body
  });
  setLoading("directMessageSendBtn", false, "Skickar…", "Skicka");
  if (error) {
    setNotice("directMessageNotice", "Meddelandet kunde inte skickas.", "error");
    return;
  }
  input.value = "";
  await loadDirectMessages();
  input.focus();
}

async function loadJobMessages() {
  const container = byId("jobChatMessages");
  if (!container || !selectedChatJobId || !currentUser) return;
  if (!container.children.length) container.innerHTML = '<div class="account-meta">Hämtar meddelanden…</div>';
  const { data, error } = await supabaseClient
    .from("job_messages")
    .select("id, sender_id, body, read_at, created_at")
    .eq("job_id", selectedChatJobId)
    .order("created_at", { ascending: true });
  if (error) {
    container.innerHTML = '<div class="notice error">Chatten kunde inte hämtas.</div>';
    return;
  }
  const messages = await markMessagesRead("job_messages", data || []);
  await markConversationNotificationsRead({ kind: "job", jobId: Number(selectedChatJobId) });
  container.innerHTML = messages.length
    ? messages.map((message) => renderChatMessage(message, selectedChatOtherLabel)).join("")
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
  const [jobsResult, reviewsResult, goalsResult] = await Promise.all([
    supabaseClient
      .from("jobs")
      .select("id, title, agreed_price_sek, budget_sek, price_type, completed_at")
      .eq("performer_id", currentUser.id)
      .eq("status", "completed")
      .order("completed_at", { ascending: false }),
    supabaseClient
      .from("reviews")
      .select("rating")
      .eq("reviewee_id", currentUser.id),
    supabaseClient
      .from("savings_goals")
      .select("id, name, target_amount_sek, saved_amount_sek, target_date, created_at, updated_at")
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false })
  ]);
  if (jobsResult.error || reviewsResult.error) {
    if (byId("earningsList")) byId("earningsList").innerHTML = '<div class="notice error">Statistiken kunde inte hämtas.</div>';
    return;
  }
  const completedJobs = jobsResult.data || [];
  completedEarningsJobs = completedJobs;
  const ratings = reviewsResult.data || [];
  const total = completedJobs.reduce((sum, job) => (
    job.price_type === "hourly" ? sum : sum + Number(job.agreed_price_sek || job.budget_sek || 0)
  ), 0);
  const average = ratings.length
    ? ratings.reduce((sum, review) => sum + Number(review.rating), 0) / ratings.length
    : 0;
  if (byId("totalEarnings")) byId("totalEarnings").textContent = formatCurrency(total);
  if (byId("completedJobsCount")) byId("completedJobsCount").textContent = String(completedJobs.length);
  if (byId("averageRating")) byId("averageRating").textContent = ratings.length
    ? `${average.toFixed(1).replace(".", ",")} ★ (${ratings.length})`
    : "Inga betyg";
  if (goalsResult.error) {
    if (byId("savingsGoalsList")) byId("savingsGoalsList").innerHTML = '<div class="notice error">Sparmålen kunde inte hämtas. Databasuppdateringen kan saknas.</div>';
  } else {
    savingsGoals = goalsResult.data || [];
    renderSavingsGoals();
  }
  if (byId("earningsList")) {
    byId("earningsList").innerHTML = completedJobs.length
      ? `<strong>Utförda jobb</strong>${completedJobs.map((job) => `
          <div class="earning-row">
            <span><strong>${escapeHtml(job.title)}</strong><br><span class="account-meta">${new Date(job.completed_at).toLocaleDateString("sv-SE")}${job.price_type === "hourly" ? " · Slutbelopp kräver bekräftade timmar" : ""}</span></span>
            <strong>${formatCurrency(job.agreed_price_sek || job.budget_sek)}${job.price_type === "hourly" ? "/tim" : ""}</strong>
          </div>`).join("")}`
      : '<div class="notice">När ett jobb markeras som klart visas summan här.</div>';
  }
}

function downloadEarningsCsv() {
  if (!completedEarningsJobs.length) {
    setNotice("accountNotice", "Det finns inga slutförda jobb att exportera ännu.", "error");
    return;
  }
  const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [
    ["Datum", "Jobb", "Ersättning", "Pristyp", "Kommentar"],
    ...completedEarningsJobs.map((job) => [
      new Date(job.completed_at).toLocaleDateString("sv-SE"),
      job.title,
      job.agreed_price_sek || job.budget_sek || 0,
      job.price_type === "hourly" ? "Timpris" : job.price_type === "quote" ? "Överenskommet pris" : "Fast pris",
      job.price_type === "hourly" ? "Angivet belopp är timpris, inte bekräftat slutbelopp" : ""
    ])
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(escapeCsv).join(";")).join("\n")}`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `grannpojkarna-intjanat-${new Date().getFullYear()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function savingsGoalPace(goal) {
  if (!goal.target_date) return "";
  const remaining = Math.max(0, Number(goal.target_amount_sek) - Number(goal.saved_amount_sek));
  const targetDate = new Date(`${goal.target_date}T23:59:59`);
  const daysLeft = Math.ceil((targetDate.getTime() - Date.now()) / 86400000);
  if (remaining === 0) return "Målet är uppnått";
  if (daysLeft <= 0) return "Måldatumet har passerat";
  const monthsLeft = Math.max(1, daysLeft / 30.44);
  return `Ca ${formatCurrency(Math.ceil(remaining / monthsLeft))}/mån till måldatum`;
}

function renderSavingsGoals() {
  const container = byId("savingsGoalsList");
  if (!container) return;
  if (!savingsGoals.length) {
    container.innerHTML = `<div class="savings-empty">
      <span aria-hidden="true">◎</span>
      <div><strong>Skapa ditt första sparmål</strong><p>Exempel: “Skidresa Åre”, 15 000 kr i mål, 6 500 kr sparat och ett frivilligt måldatum.</p></div>
      <button class="btn btn-primary btn-small" type="button" onclick="openSavingsGoalForm()">Skapa sparmål</button>
    </div>`;
    return;
  }
  container.innerHTML = savingsGoals.map((goal) => {
    const target = Number(goal.target_amount_sek || 0);
    const saved = Number(goal.saved_amount_sek || 0);
    const percent = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
    const remaining = Math.max(0, target - saved);
    const targetDate = goal.target_date
      ? new Date(`${goal.target_date}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" })
      : "Inget måldatum";
    const pace = savingsGoalPace(goal);
    return `<article class="savings-goal-card">
      <div class="savings-goal-top"><div><span>Sparmål</span><h4>${escapeHtml(goal.name)}</h4></div><strong>${percent}%</strong></div>
      <div class="goal-progress" aria-label="${percent} procent av målet"><span style="width:${percent}%"></span></div>
      <div class="savings-goal-amount"><strong>${formatCurrency(saved)}</strong><span>av ${formatCurrency(target)}</span></div>
      <div class="savings-goal-facts"><span>${remaining ? `${formatCurrency(remaining)} kvar` : "Målet är nått"}</span><span>${escapeHtml(targetDate)}</span>${pace ? `<span>${escapeHtml(pace)}</span>` : ""}</div>
      <div class="savings-goal-actions"><button class="link-button" type="button" onclick="openSavingsGoalForm(${goal.id})">Redigera</button><button class="link-button danger-link" type="button" onclick="deleteSavingsGoal(${goal.id})">Ta bort</button></div>
    </article>`;
  }).join("");
}

function openSavingsGoalForm(goalId = null) {
  const goal = savingsGoals.find((item) => Number(item.id) === Number(goalId));
  editingSavingsGoalId = goal ? Number(goal.id) : null;
  if (byId("savingsGoalFormTitle")) byId("savingsGoalFormTitle").textContent = goal ? "Redigera sparmål" : "Nytt sparmål";
  if (byId("savingsGoalName")) byId("savingsGoalName").value = goal?.name || "";
  if (byId("savingsGoalTarget")) byId("savingsGoalTarget").value = goal?.target_amount_sek || "";
  if (byId("savingsGoalSaved")) byId("savingsGoalSaved").value = goal?.saved_amount_sek || "";
  if (byId("savingsGoalDate")) byId("savingsGoalDate").value = goal?.target_date || "";
  byId("savingsGoalForm")?.classList.remove("hidden");
  setNotice("savingsGoalNotice");
  setTimeout(() => byId("savingsGoalName")?.focus(), 50);
}

function closeSavingsGoalForm() {
  editingSavingsGoalId = null;
  byId("savingsGoalForm")?.classList.add("hidden");
  byId("savingsGoalForm")?.reset();
  setNotice("savingsGoalNotice");
}

async function saveSavingsGoal(event) {
  event?.preventDefault();
  if (!currentUser || !currentProfile) return;
  const name = byId("savingsGoalName")?.value.trim() || "";
  const target = parseBudget(byId("savingsGoalTarget")?.value || "");
  const saved = parseBudget(byId("savingsGoalSaved")?.value || "") || 0;
  const targetDate = byId("savingsGoalDate")?.value || null;
  if (name.length < 2 || !target) {
    setNotice("savingsGoalNotice", "Ange ett namn och ett målbelopp i kronor.", "error");
    return;
  }
  setLoading("saveGoalBtn", true, "Sparar…", "Spara mål");
  const payload = {
    user_id: currentUser.id,
    name,
    target_amount_sek: target,
    saved_amount_sek: saved,
    target_date: targetDate
  };
  const request = editingSavingsGoalId
    ? supabaseClient.from("savings_goals").update(payload).eq("id", editingSavingsGoalId).eq("user_id", currentUser.id)
    : supabaseClient.from("savings_goals").insert(payload);
  const { error } = await request;
  setLoading("saveGoalBtn", false, "Sparar…", "Spara mål");
  if (error) {
    setNotice("savingsGoalNotice", "Sparmålet kunde inte sparas.", "error");
    return;
  }
  closeSavingsGoalForm();
  setNotice("accountNotice", "Sparmålet har sparats.", "success");
  await loadEarnings();
}

async function deleteSavingsGoal(goalId) {
  const goal = savingsGoals.find((item) => Number(item.id) === Number(goalId));
  if (!goal || !window.confirm(`Ta bort sparmålet ”${goal.name}”?`)) return;
  const { error } = await supabaseClient
    .from("savings_goals")
    .delete()
    .eq("id", goalId)
    .eq("user_id", currentUser.id);
  if (error) {
    setNotice("accountNotice", "Sparmålet kunde inte tas bort.", "error");
    return;
  }
  setNotice("accountNotice", "Sparmålet har tagits bort.", "success");
  await loadEarnings();
}

function ensureSafetyReportModal() {
  if (byId("safetyReportModal")) return;
  document.body.insertAdjacentHTML("beforeend", `<div class="modal" id="safetyReportModal"><div class="dialog report-dialog"><div class="dialog-top"><div><span class="eyebrow">Trygghetscenter</span><h3>Anmäl innehåll</h3></div><button class="close" type="button" onclick="closeSafetyReport()" aria-label="Stäng">×</button></div><p class="auth-intro" id="safetyReportTarget"></p><form class="auth-stack" onsubmit="submitSafetyReport(event)"><div class="field"><label for="safetyReportReason">Vad gäller det?</label><select id="safetyReportReason" required><option value="misleading">Vilseledande information</option><option value="unsafe">Farligt eller olagligt</option><option value="spam">Spam eller falsk annons</option><option value="harassment">Trakasserier eller olämpligt beteende</option><option value="other">Annat</option></select></div><div class="field"><label for="safetyReportDetails">Beskriv kort vad som hänt</label><textarea id="safetyReportDetails" rows="5" minlength="10" maxlength="1500" required></textarea></div><div class="field" id="safetyReportEmailField"><label for="safetyReportEmail">Din mejladress</label><input id="safetyReportEmail" type="email" autocomplete="email" placeholder="du@exempel.se" /><span class="field-help">Behövs utan konto så att vi kan be om mer information.</span></div><div class="field honeypot" aria-hidden="true"><label for="safetyReportWebsite">Webbplats</label><input id="safetyReportWebsite" tabindex="-1" autocomplete="off" /></div><button class="btn btn-primary" id="safetyReportSubmitBtn" type="submit">Skicka anmälan</button><div class="notice hidden" id="safetyReportNotice" role="status"></div></form></div></div>`);
}

function openSafetyReport(kind, targetId) {
  ensureSafetyReportModal();
  const isJob = kind === "job";
  const job = isJob ? [...publicJobs, ...ownJobs, ...assignedJobs].find((item) => Number(item.id) === Number(targetId)) : null;
  const profile = !isJob && selectedDirectProfile?.id === targetId ? selectedDirectProfile : null;
  reportTarget = { kind: isJob ? "job" : "profile", id: targetId };
  if (byId("safetyReportTarget")) byId("safetyReportTarget").textContent = isJob ? `Du anmäler jobbannonsen “${job?.title || "Jobb"}”.` : `Du anmäler profilen ${profile?.display_name || "Utförare"}.`;
  byId("safetyReportEmailField")?.classList.toggle("hidden", Boolean(currentUser));
  if (byId("safetyReportEmail")) byId("safetyReportEmail").value = currentUser?.email || "";
  setNotice("safetyReportNotice");
  byId("safetyReportModal")?.classList.add("show");
  setTimeout(() => byId("safetyReportReason")?.focus(), 50);
}

function closeSafetyReport() {
  reportTarget = null;
  byId("safetyReportModal")?.classList.remove("show");
  byId("safetyReportModal")?.querySelector("form")?.reset();
}

async function submitSafetyReport(event) {
  event.preventDefault();
  if (!reportTarget || byId("safetyReportWebsite")?.value) return;
  const details = byId("safetyReportDetails")?.value.trim() || "";
  const contactEmail = currentUser?.email || byId("safetyReportEmail")?.value.trim() || "";
  if (details.length < 10 || (!currentUser && !contactEmail.includes("@"))) {
    setNotice("safetyReportNotice", "Beskriv vad som hänt och ange en giltig mejladress.", "error");
    return;
  }
  setLoading("safetyReportSubmitBtn", true, "Skickar…", "Skicka anmälan");
  const { error } = await supabaseClient.from("safety_reports").insert({
    reporter_id: currentUser?.id || null,
    target_job_id: reportTarget.kind === "job" ? Number(reportTarget.id) : null,
    target_user_id: reportTarget.kind === "profile" ? reportTarget.id : null,
    reason: byId("safetyReportReason")?.value || "other",
    details,
    contact_email: contactEmail || null
  });
  setLoading("safetyReportSubmitBtn", false, "Skickar…", "Skicka anmälan");
  if (error) {
    setNotice("safetyReportNotice", "Anmälan kunde inte skickas. Försök igen eller mejla oss.", "error");
    return;
  }
  setNotice("safetyReportNotice", "Tack. Anmälan är mottagen och kommer att granskas.", "success");
  setTimeout(closeSafetyReport, 1100);
}

async function requestPrivacyAction(type) {
  if (!currentUser || !["export", "delete"].includes(type)) return;
  const message = type === "delete"
    ? "Skicka en begäran om att radera kontot? Vi kontaktar dig innan raderingen genomförs."
    : "Skicka en begäran om ett utdrag av dina personuppgifter?";
  if (!window.confirm(message)) return;
  const { error } = await supabaseClient.from("privacy_requests").insert({ user_id: currentUser.id, request_type: type });
  setNotice("accountNotice", error ? "Begäran kunde inte skickas." : "Begäran är mottagen. Vi återkommer via din mejladress.", error ? "error" : "success");
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
    .select("id, user_id, title, description, location, latitude, longitude, timing, date_start, date_end, image_paths, budget_sek, price_type, category, status, created_at")
    .eq("status", "open")
    .order("created_at", { ascending: false });
  if (error) {
    renderJobsError("Jobben kunde inte hämtas. Databasuppdateringen kan saknas.");
    return;
  }
  publicJobs = data || [];
  applyJobFilters();
}

const geocodeStorageKey = "grannpojkarna.geocode-cache.v1";
const knownAreaCoordinates = {
  stockholm: [59.3293, 18.0686], solna: [59.3600, 18.0009], sundbyberg: [59.3613, 17.9711],
  taby: [59.4439, 18.0687], danderyd: [59.4059, 18.0363], lidingo: [59.3664, 18.1334],
  nacka: [59.3098, 18.1637], huddinge: [59.2370, 17.9819], botkyrka: [59.1988, 17.8332],
  haninge: [59.1677, 18.1448], tyresö: [59.2442, 18.2294], tyreso: [59.2442, 18.2294],
  sollentuna: [59.4280, 17.9509], jarfalla: [59.4232, 17.8303], upplandsvasby: [59.5184, 17.9113],
  "upplands vasby": [59.5184, 17.9113], vallentuna: [59.5344, 18.0776], osteraker: [59.4795, 18.2997],
  vaxholm: [59.4022, 18.3532], norrtalje: [59.7580, 18.7050], ekero: [59.2910, 17.8121],
  salem: [59.2008, 17.7665], sodertalje: [59.1955, 17.6253], uppsala: [59.8586, 17.6389],
  goteborg: [57.7089, 11.9746], malmo: [55.6050, 13.0038], vasteras: [59.6099, 16.5448],
  orebro: [59.2753, 15.2134], linkoping: [58.4108, 15.6214], jonkoping: [57.7826, 14.1618]
};

function normalizeArea(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function approximateCoordinatesFor(value) {
  const normalized = normalizeArea(value);
  if (!normalized) return null;
  const match = Object.entries(knownAreaCoordinates)
    .filter(([area]) => normalized.includes(normalizeArea(area)))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return match ? { latitude: match[1][0], longitude: match[1][1] } : null;
}

function readGeocodeCache() {
  try { return JSON.parse(window.localStorage.getItem(geocodeStorageKey) || "{}"); }
  catch { return {}; }
}

async function geocodeArea(value) {
  const query = String(value || "").trim();
  if (!query) return null;
  const known = approximateCoordinatesFor(query);
  if (known) return known;
  const key = normalizeArea(query);
  const cache = readGeocodeCache();
  if (cache[key] && Number.isFinite(cache[key].latitude) && Number.isFinite(cache[key].longitude)) return cache[key];
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4500);
  try {
    // En enda användarutlöst sökning, utan autocomplete. Resultatet sparas lokalt
    // så att OpenStreetMaps publika geokodningstjänst inte anropas i onödan.
    const url = new URL(appConfig.geocodingUrl || "https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "se");
    url.searchParams.set("q", `${query}, Sverige`);
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    const latitude = Math.round(Number(data?.[0]?.lat) * 100) / 100;
    const longitude = Math.round(Number(data?.[0]?.lon) * 100) / 100;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const coordinates = { latitude, longitude };
    const entries = Object.entries({ ...cache, [key]: coordinates }).slice(-50);
    window.localStorage.setItem(geocodeStorageKey, JSON.stringify(Object.fromEntries(entries)));
    return coordinates;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function getJobCoordinates(job) {
  if (job?.latitude === null || job?.latitude === undefined || job?.longitude === null || job?.longitude === undefined) {
    return approximateCoordinatesFor(job?.location);
  }
  const latitude = Number(job?.latitude);
  const longitude = Number(job?.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
    return { latitude, longitude };
  }
  return approximateCoordinatesFor(job?.location);
}

function distanceKm(from, to) {
  if (!from || !to) return null;
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusKm = 6371;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function jobDistance(job) {
  return jobFilterOrigin ? distanceKm(jobFilterOrigin, getJobCoordinates(job)) : null;
}

function jobMatchScore(job) {
  if (!currentProfile?.performer_enabled) return null;
  const haystack = normalizeArea(`${job.title || ""} ${job.description || ""} ${job.category || ""}`);
  const skills = Array.isArray(currentProfile.skills) ? currentProfile.skills.map(normalizeArea).filter(Boolean) : [];
  const skillScore = skills.some((skill) => haystack.includes(skill) || skill.includes(normalizeArea(job.category))) ? 45 : 12;
  const profileArea = normalizeArea(currentProfile.service_area);
  const jobArea = normalizeArea(job.location);
  let areaScore = profileArea && jobArea && (profileArea.includes(jobArea) || jobArea.includes(profileArea)) ? 35 : 8;
  if (areaScore < 35) {
    const profileCoordinates = approximateCoordinatesFor(currentProfile.service_area);
    const areaDistance = distanceKm(profileCoordinates, getJobCoordinates(job));
    if (areaDistance !== null) areaScore = areaDistance <= 10 ? 32 : areaDistance <= 25 ? 22 : 8;
  }
  const availabilityScore = ["now", "today"].includes(currentProfile.availability_status) ? 20 : 10;
  return Math.min(100, skillScore + areaScore + availabilityScore);
}

async function handleDistanceFilterChange() {
  const radius = Number(byId("filterDistance")?.value || 0);
  const location = byId("filterLocation")?.value.trim() || "";
  if (!radius) {
    jobFilterOrigin = null;
    jobFilterOriginLabel = "";
    if (byId("distanceFilterStatus")) byId("distanceFilterStatus").textContent = "Skriv ett område ovan för att söka på avstånd.";
    applyJobFilters();
    return;
  }
  if (!location) {
    if (byId("filterDistance")) byId("filterDistance").value = "";
    if (byId("distanceFilterStatus")) byId("distanceFilterStatus").textContent = "Skriv först en ort eller ett område.";
    applyJobFilters();
    return;
  }
  if (byId("distanceFilterStatus")) byId("distanceFilterStatus").textContent = "Hittar området…";
  const coordinates = await geocodeArea(location);
  if (!coordinates) {
    jobFilterOrigin = null;
    jobFilterOriginLabel = "";
    if (byId("filterDistance")) byId("filterDistance").value = "";
    if (byId("distanceFilterStatus")) byId("distanceFilterStatus").textContent = "Området kunde inte hittas. Prova en närliggande ort.";
    applyJobFilters();
    return;
  }
  jobFilterOrigin = coordinates;
  jobFilterOriginLabel = normalizeArea(location);
  if (byId("distanceFilterStatus")) byId("distanceFilterStatus").textContent = `Visar jobb inom ${radius} km från ${location}.`;
  applyJobFilters();
}

function handleLocationFilterInput() {
  const currentLabel = normalizeArea(byId("filterLocation")?.value);
  if (jobFilterOrigin && currentLabel !== jobFilterOriginLabel) {
    jobFilterOrigin = null;
    jobFilterOriginLabel = "";
    if (byId("filterDistance")) byId("filterDistance").value = "";
    if (byId("distanceFilterStatus")) byId("distanceFilterStatus").textContent = "Välj avstånd igen för det nya området.";
  }
  applyJobFilters();
}

function applyJobFilters() {
  if (!byId("publicJobs")) return;
  const search = (byId("filterSearch")?.value || "").trim().toLowerCase();
  const category = byId("filterCategory")?.value || "";
  const location = (byId("filterLocation")?.value || "").trim().toLowerCase();
  const timing = byId("filterTiming")?.value || "";
  const minBudget = Number(byId("filterMinBudget")?.value || 0);
  const radius = Number(byId("filterDistance")?.value || 0);
  const sort = byId("filterSort")?.value || "newest";
  const candidates = publicJobs.filter((job) => {
    const searchable = `${job.title || ""} ${job.description || ""} ${job.category || ""}`.toLowerCase();
    return (!search || searchable.includes(search))
      && (!category || job.category === category)
      && (!timing || matchesJobTiming(job, timing))
      && (!minBudget || Number(job.budget_sek) >= minBudget);
  });
  const filtered = candidates.filter((job) => {
    if (radius && jobFilterOrigin) {
      const distance = jobDistance(job);
      return distance !== null && distance <= radius;
    }
    return !location || String(job.location || "").toLowerCase().includes(location);
  });
  filtered.sort((a, b) => {
    if (sort === "match") return Number(jobMatchScore(b) || 0) - Number(jobMatchScore(a) || 0);
    if (sort === "highest") return Number(b.budget_sek) - Number(a.budget_sek);
    if (sort === "lowest") return Number(a.budget_sek) - Number(b.budget_sek);
    return new Date(b.created_at) - new Date(a.created_at);
  });
  const nearbyOrigin = jobFilterOrigin || approximateCoordinatesFor(location);
  const nearby = !filtered.length && location && nearbyOrigin
    ? candidates
        .map((job) => ({ job, distance: distanceKm(nearbyOrigin, getJobCoordinates(job)) }))
        .filter((item) => item.distance !== null && item.distance <= Math.max(50, radius * 3) && (!radius || item.distance > radius))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3)
        .map((item) => item.job)
    : [];
  visiblePublicJobs = filtered;
  nearbyPublicJobs = nearby;
  renderPublicJobs(filtered, nearby);
  if (activeJobView === "map") renderJobsMap(filtered.length ? filtered : nearby);
}

function matchesJobTiming(job, filter) {
  const today = new Date();
  const toKey = (date) => date.toISOString().slice(0, 10);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);
  const start = job.date_start || "";
  const end = job.date_end || start;
  if (filter === "today") return job.timing === "Idag" || (start && start <= toKey(today) && end >= toKey(today));
  if (filter === "tomorrow") return job.timing === "Imorgon" || (start && start <= toKey(tomorrow) && end >= toKey(tomorrow));
  if (filter === "week") return job.timing === "Den här veckan" || (start && start <= toKey(weekEnd) && end >= toKey(today));
  if (filter === "later") return !start && ["Kom överens senare", "Välj datum senare"].includes(job.timing);
  return true;
}

function renderPublicJobCard(job) {
  const isOwnJob = currentUser?.id === job.user_id;
  const matchScore = jobMatchScore(job);
  const distance = jobDistance(job);
  return `
    <article class="feed-card" id="publicJob-${job.id}">
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
        <div class="job-card-badges">
          ${matchScore !== null ? `<span class="job-match-pill">Passar dig ${matchScore}%</span>` : ""}
          ${distance !== null ? `<span class="job-distance-pill">${distance < 10 ? distance.toFixed(1).replace(".", ",") : Math.round(distance)} km</span>` : ""}
          <div class="feed-price">${formatPrice(job)}</div>
        </div>
      </div>
      ${renderJobImages(job.image_paths)}
      <p>${escapeHtml(job.description)}</p>
      <div class="feed-card-footer">
        <div><span class="account-meta">${job.price_type === "hourly" ? "Ersättning per timme" : job.price_type === "quote" ? "Beställaren är öppen för prisförslag" : "Fast ersättning"}</span><br><button class="link-button danger-link report-link" type="button" onclick="openSafetyReport('job', ${job.id})">Anmäl annonsen</button></div>
        <button class="btn ${isOwnJob ? "btn-light" : "btn-primary"} btn-small" ${isOwnJob ? "disabled" : ""} onclick="beginApplication(${job.id})">${isOwnJob ? "Ditt jobb" : "Ta jobbet"}</button>
      </div>
    </article>`;
}

function renderPublicJobs(jobs, nearby = []) {
  const container = byId("publicJobs");
  if (!container) return;
  if (byId("jobsCount")) byId("jobsCount").textContent = nearby.length && !jobs.length
    ? `0 exakta träffar · ${nearby.length} i närheten`
    : `${jobs.length} ${jobs.length === 1 ? "öppet jobb" : "öppna jobb"}`;
  if (!jobs.length) {
    if (nearby.length) {
      container.innerHTML = `<div class="nearby-results">
        <div class="nearby-results-intro"><strong>Inga jobb exakt där du sökte</strong><span>Här är de närmaste jobben från närliggande områden.</span></div>
        ${nearby.map(renderPublicJobCard).join("")}
      </div>`;
      return;
    }
    container.innerHTML = `
      <div class="empty-state">
        <h2>Inga jobb matchar filtret</h2>
        <p>Prova att rensa något filter eller kom tillbaka snart när fler jobb har lagts upp.</p>
        <button class="btn btn-light" onclick="resetJobFilters()">Rensa filter</button>
      </div>`;
    return;
  }
  container.innerHTML = jobs.map(renderPublicJobCard).join("");
}

function initializeJobsMap() {
  if (jobsMap || jobsMapFallback || !byId("jobsMap") || !window.maplibregl) return Boolean(jobsMap);
  try {
    jobsMap = new window.maplibregl.Map({
      container: "jobsMap",
      style: appConfig.mapStyleUrl || "https://tiles.openfreemap.org/styles/positron",
      center: [18.0686, 59.3293],
      zoom: 9,
      maxZoom: 17,
      attributionControl: false
    });
  } catch {
    jobsMapFallback = true;
    jobsMap = null;
    return false;
  }
  jobsMap.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-left");
  jobsMap.addControl(new window.maplibregl.AttributionControl({
    compact: true,
    customAttribution: appConfig.mapAttributionHtml || '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  }));
  jobsMap.on("load", () => {
    jobsMapLoaded = true;
    renderJobsMap(jobsMapPendingJobs);
  });
  window.setTimeout(() => {
    if (jobsMapLoaded || !jobsMap) return;
    jobsMap.remove();
    jobsMap = null;
    jobsMapFallback = true;
    if (activeJobView === "map") renderStaticJobsMap(jobsMapPendingJobs);
  }, 8000);
  return true;
}

function renderJobsMap(jobs) {
  jobsMapPendingJobs = jobs;
  if (jobsMapFallback) {
    renderStaticJobsMap(jobs);
    return;
  }
  if (!initializeJobsMap()) {
    if (jobsMapFallback) renderStaticJobsMap(jobs);
    else if (byId("jobsMapStatus")) byId("jobsMapStatus").textContent = "Kartan laddas… Jobben finns alltid kvar i listvyn.";
    return;
  }
  if (!jobsMapLoaded) {
    if (byId("jobsMapStatus")) byId("jobsMapStatus").textContent = "Kartan laddas…";
    return;
  }
  jobsMapMarkers.forEach((marker) => marker.remove());
  jobsMapMarkers = [];
  const bounds = new window.maplibregl.LngLatBounds();
  let markerCount = 0;
  let missingPositions = 0;
  jobs.forEach((job) => {
    const coordinates = getJobCoordinates(job);
    if (!coordinates) { missingPositions += 1; return; }
    const element = document.createElement("button");
    element.className = "job-map-marker";
    element.type = "button";
    element.setAttribute("aria-label", `${job.title || job.category}, ${job.location}`);
    const popup = new window.maplibregl.Popup({ offset: 18, maxWidth: "260px" })
      .setHTML(`<div class="job-map-popup"><strong>${escapeHtml(job.title || job.category)}</strong><span>${escapeHtml(job.location)} · ${escapeHtml(formatPrice(job))}</span><button type="button" onclick="focusJobInList(${Number(job.id)})">Visa jobbet</button></div>`);
    const marker = new window.maplibregl.Marker({ element })
      .setLngLat([coordinates.longitude, coordinates.latitude])
      .setPopup(popup)
      .addTo(jobsMap);
    jobsMapMarkers.push(marker);
    bounds.extend([coordinates.longitude, coordinates.latitude]);
    markerCount += 1;
  });
  if (markerCount === 1) jobsMap.easeTo({ center: bounds.getCenter(), zoom: 12 });
  else if (markerCount > 1) jobsMap.fitBounds(bounds, { padding: 60, maxZoom: 13 });
  else jobsMap.easeTo({ center: [18.0686, 59.3293], zoom: 9 });
  if (byId("jobsMapStatus")) byId("jobsMapStatus").textContent = markerCount
    ? `${markerCount} jobb på kartan. Positionerna är ungefärliga.${missingPositions ? ` ${missingPositions} visas bara i listan.` : ""}`
    : "Inga av träffarna har en kartposition ännu. Växla till listan för att se dem.";
}

function renderStaticJobsMap(jobs) {
  const container = byId("jobsMap");
  if (!container) return;
  container.className = "static-jobs-map";
  container.innerHTML = '<div class="static-map-north">N</div><div class="static-map-water" aria-hidden="true"></div>';
  const locatedJobs = jobs.map((job) => ({ job, coordinates: getJobCoordinates(job) })).filter((item) => item.coordinates);
  if (!locatedJobs.length) {
    if (byId("jobsMapStatus")) byId("jobsMapStatus").textContent = "Inga av träffarna har en kartposition ännu. Växla till listan för att se dem.";
    return;
  }
  const latitudes = locatedJobs.map((item) => item.coordinates.latitude);
  const longitudes = locatedJobs.map((item) => item.coordinates.longitude);
  const minLatitude = Math.min(...latitudes) - .02;
  const maxLatitude = Math.max(...latitudes) + .02;
  const minLongitude = Math.min(...longitudes) - .03;
  const maxLongitude = Math.max(...longitudes) + .03;
  locatedJobs.forEach(({ job, coordinates }, index) => {
    const marker = document.createElement("button");
    marker.className = "static-job-marker";
    marker.type = "button";
    marker.textContent = String(index + 1);
    marker.dataset.label = String(job.location || job.title || "Jobb").slice(0, 22);
    marker.setAttribute("aria-label", `${job.title || job.category}, ${job.location}`);
    marker.style.left = `${12 + 76 * ((coordinates.longitude - minLongitude) / Math.max(.01, maxLongitude - minLongitude))}%`;
    marker.style.top = `${12 + 76 * (1 - (coordinates.latitude - minLatitude) / Math.max(.01, maxLatitude - minLatitude))}%`;
    marker.addEventListener("click", () => focusJobInList(job.id));
    container.appendChild(marker);
  });
  if (byId("jobsMapStatus")) byId("jobsMapStatus").textContent = `${locatedJobs.length} jobb i en förenklad kartvy. Positionerna är ungefärliga.`;
}

function setJobView(view) {
  activeJobView = view === "map" ? "map" : "list";
  byId("publicJobs")?.classList.toggle("hidden", activeJobView === "map");
  byId("jobsMapPanel")?.classList.toggle("hidden", activeJobView !== "map");
  byId("jobListViewBtn")?.classList.toggle("is-active", activeJobView === "list");
  byId("jobMapViewBtn")?.classList.toggle("is-active", activeJobView === "map");
  byId("jobListViewBtn")?.setAttribute("aria-pressed", String(activeJobView === "list"));
  byId("jobMapViewBtn")?.setAttribute("aria-pressed", String(activeJobView === "map"));
  if (activeJobView === "map") {
    renderJobsMap(visiblePublicJobs.length ? visiblePublicJobs : nearbyPublicJobs);
    window.setTimeout(() => jobsMap?.resize?.(), 0);
  }
}

function focusJobInList(jobId) {
  setJobView("list");
  window.setTimeout(() => byId(`publicJob-${jobId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
}

function renderJobsError(message) {
  if (byId("jobsCount")) byId("jobsCount").textContent = "Jobblistan kunde inte laddas";
  if (byId("publicJobs")) byId("publicJobs").innerHTML = `<div class="notice error">${escapeHtml(message)}</div>`;
}

function resetJobFilters() {
  ["filterSearch", "filterCategory", "filterLocation", "filterDistance", "filterTiming", "filterMinBudget"].forEach((id) => {
    if (byId(id)) byId(id).value = "";
  });
  jobFilterOrigin = null;
  jobFilterOriginLabel = "";
  if (byId("distanceFilterStatus")) byId("distanceFilterStatus").textContent = "Skriv ett område ovan för att söka på avstånd.";
  if (byId("filterSort")) byId("filterSort").value = "newest";
  applyJobFilters();
}

function toggleJobFilters() {
  byId("jobFilters")?.classList.toggle("show");
}

function jobAlertName(filters) {
  const area = filters.location
    ? filters.radius ? `inom ${filters.radius} km från ${filters.location}` : `i ${filters.location}`
    : "";
  const parts = [filters.category, filters.searchTerm, area, filters.minBudget ? `över ${formatCurrency(filters.minBudget)}` : ""].filter(Boolean);
  return (parts.join(" ") || "Alla nya jobb").slice(0, 100);
}

async function saveCurrentJobAlert() {
  if (!currentUser || !currentProfile) {
    pendingJobAlert = true;
    openAccountModal("performer");
    return;
  }
  const filters = {
    searchTerm: byId("filterSearch")?.value.trim() || null,
    category: byId("filterCategory")?.value || null,
    location: byId("filterLocation")?.value.trim() || null,
    radius: Number(byId("filterDistance")?.value || 0) || null,
    timing: byId("filterTiming")?.value || null,
    minBudget: Number(byId("filterMinBudget")?.value || 0) || null
  };
  setLoading("saveJobAlertBtn", true, "Sparar…", "Skapa bevakning");
  const alertOrigin = filters.radius && filters.location
    ? jobFilterOrigin || await geocodeArea(filters.location)
    : null;
  if (filters.radius && !alertOrigin) {
    setLoading("saveJobAlertBtn", false, "Sparar…", "Skapa bevakning");
    setNotice("jobAlertNotice", "Området kunde inte hittas. Prova en närliggande ort eller välj Alla avstånd.", "error");
    return;
  }
  const { error } = await supabaseClient.from("job_alerts").insert({
    user_id: currentUser.id,
    name: jobAlertName(filters),
    search_term: filters.searchTerm,
    category: filters.category,
    location: filters.location,
    origin_latitude: alertOrigin?.latitude ?? null,
    origin_longitude: alertOrigin?.longitude ?? null,
    radius_km: filters.radius,
    timing: filters.timing,
    min_budget_sek: filters.minBudget,
    email_enabled: true
  });
  setLoading("saveJobAlertBtn", false, "Sparar…", "Skapa bevakning");
  if (error) {
    setNotice("jobAlertNotice", "Bevakningen kunde inte sparas. Försök igen.", "error");
    return;
  }
  setNotice("jobAlertNotice", "Klart! Du får mejl när ett nytt jobb matchar.", "success");
}

function jobAlertSummary(alert) {
  const area = alert.location
    ? alert.radius_km ? `inom ${alert.radius_km} km från ${alert.location}` : alert.location
    : "";
  const parts = [alert.category, area, alert.search_term ? `“${alert.search_term}”` : "", alert.min_budget_sek ? `minst ${formatCurrency(alert.min_budget_sek)}` : ""].filter(Boolean);
  return parts.join(" · ") || "Alla nya jobb";
}

async function loadJobAlerts() {
  const container = byId("jobAlertsList");
  if (!container || !currentUser || !supabaseClient) return;
  const { data, error } = await supabaseClient.from("job_alerts").select("id, name, search_term, category, location, origin_latitude, origin_longitude, radius_km, timing, min_budget_sek, email_enabled, created_at").eq("user_id", currentUser.id).order("created_at", { ascending: false });
  jobAlerts = error ? [] : data || [];
  container.className = "job-alerts-list";
  container.innerHTML = jobAlerts.length
    ? jobAlerts.map((alert) => `<div class="job-alert-row"><div><strong>${escapeHtml(alert.name)}</strong><span>${escapeHtml(jobAlertSummary(alert))} · ${alert.email_enabled ? "Mejl aktivt" : "Mejl pausat"}</span></div><div class="account-actions"><button class="link-button" type="button" onclick="toggleJobAlert(${alert.id}, ${!alert.email_enabled})">${alert.email_enabled ? "Pausa" : "Aktivera"}</button><button class="link-button danger-link" type="button" onclick="deleteJobAlert(${alert.id})">Ta bort</button></div></div>`).join("")
    : '<span class="account-meta">Inga bevakningar ännu.</span>';
}

async function toggleJobAlert(alertId, enabled) {
  const { error } = await supabaseClient.from("job_alerts").update({ email_enabled: Boolean(enabled) }).eq("id", alertId).eq("user_id", currentUser.id);
  if (error) setNotice("accountNotice", "Bevakningen kunde inte ändras.", "error");
  else await loadJobAlerts();
}

async function deleteJobAlert(alertId) {
  if (!window.confirm("Ta bort bevakningen?")) return;
  const { error } = await supabaseClient.from("job_alerts").delete().eq("id", alertId).eq("user_id", currentUser.id);
  if (error) setNotice("accountNotice", "Bevakningen kunde inte tas bort.", "error");
  else {
    setNotice("accountNotice", "Bevakningen har tagits bort.", "success");
    await loadJobAlerts();
  }
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
        <strong><button class="profile-link-button" type="button" onclick="openPerformerProfile('${performer.id}')">${escapeHtml(performer.display_name || "Utförare")}</button></strong>
        ${establishedProfileBadge(performer.id)}
        <span>${escapeHtml(performer.service_area || "Område ej angivet")}</span>
        <div class="job-live-person-actions">
          <button class="link-button" type="button" onclick="openPerformerProfile('${performer.id}')">Visa profil</button>
          <button class="link-button" type="button" onclick="beginDirectMessage('${performer.id}')">Skicka meddelande</button>
        </div>
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
            <h2><button class="profile-link-button" type="button" onclick="openPerformerProfile('${performer.id}')">${escapeHtml(performer.display_name || "Utförare")}</button></h2>
            ${establishedProfileBadge(performer.id)}
            <div class="rating-line">${reviewCount ? `${rating.toFixed(1).replace(".", ",")} ★ · ${reviewCount} betyg` : "Ny utförare · inga betyg ännu"}</div>
          </div>
        </div>
        ${performer.bio ? `<p>${escapeHtml(performer.bio)}</p>` : '<p class="account-meta">Ingen presentation ännu.</p>'}
        <div class="performer-details">
          <span>📍 ${escapeHtml(performer.service_area || "Område ej angivet")}</span>
          <span>✓ ${Number(performer.completed_jobs || 0)} utförda jobb</span>
        </div>
        ${skills.length ? `<div class="skill-list">${skills.map((skill) => `<span>${escapeHtml(skill)}</span>`).join("")}</div>` : ""}
        <div class="performer-card-actions">
          <button class="btn btn-light btn-small" type="button" onclick="openPerformerProfile('${performer.id}')">Visa profil</button>
          <button class="btn btn-primary btn-small" type="button" onclick="beginDirectMessage('${performer.id}')">Meddelande</button>
        </div>
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
  byId("applicationForm")?.reset();
  if (byId("applicationJobTitle")) byId("applicationJobTitle").textContent = job.title || job.category;
  if (byId("applicationAcceptLabel")) byId("applicationAcceptLabel").textContent = `Ta jobbet · ${formatPrice(job)}`;
  if (byId("applicationPriceLabel")) byId("applicationPriceLabel").textContent = job.price_type === "hourly" ? "Ditt motbud per timme" : "Ditt motbud";
  if (byId("applicationPrice")) byId("applicationPrice").placeholder = job.price_type === "hourly" ? "Exempel: 250 kr/tim" : "Exempel: 700 kr";
  if (byId("applicationPriceHelp")) byId("applicationPriceHelp").textContent = job.price_type === "hourly"
    ? "Motbudet gäller per arbetad timme."
    : "Beställaren kan välja att acceptera ditt prisförslag.";
  updateApplicationOfferChoice();
  setNotice("applicationNotice");
  byId("applicationModal")?.classList.add("show");
  setTimeout(() => byId("applicationMessage")?.focus(), 50);
}

function updateApplicationOfferChoice() {
  const isCounterOffer = document.querySelector('input[name="applicationOfferType"]:checked')?.value === "counter";
  byId("applicationCounterofferField")?.classList.toggle("hidden", !isCounterOffer);
  if (byId("applicationPrice")) {
    byId("applicationPrice").required = isCounterOffer;
    if (!isCounterOffer) byId("applicationPrice").value = "";
  }
  const message = byId("applicationMessage");
  if (message) {
    message.required = isCounterOffer;
    message.placeholder = isCounterOffer
      ? "Förklara kort ditt motbud och när du kan hjälpa till"
      : "Skriv gärna när du kan börja eller om du har någon fråga";
  }
  if (byId("applicationMessageLabel")) byId("applicationMessageLabel").innerHTML = isCounterOffer
    ? "Meddelande till beställaren"
    : 'Meddelande till beställaren <span class="optional-label">Frivilligt</span>';
  if (byId("applicationMessageHelp")) byId("applicationMessageHelp").textContent = isCounterOffer
    ? "Beskriv varför du föreslår ett annat pris."
    : "Du kan ta jobbet direkt utan att skriva ett meddelande.";
  if (byId("applicationSubmitBtn")) byId("applicationSubmitBtn").textContent = isCounterOffer ? "Skicka motbud" : "Ta jobbet";
}

function closeApplicationModal() {
  selectedApplicationJobId = null;
  byId("applicationModal")?.classList.remove("show");
}

async function submitApplication(event) {
  event.preventDefault();
  if (!selectedApplicationJobId || !currentUser || !currentProfile?.performer_enabled) return;
  const job = publicJobs.find((item) => Number(item.id) === Number(selectedApplicationJobId));
  if (!job) return;
  const message = byId("applicationMessage").value.trim();
  const isCounterOffer = document.querySelector('input[name="applicationOfferType"]:checked')?.value === "counter";
  const proposedPrice = isCounterOffer ? parseBudget(byId("applicationPrice").value) : Number(job.budget_sek);
  if (message && message.length < 10) {
    setNotice("applicationNotice", "Skriv minst tio tecken i meddelandet eller lämna det tomt.", "error");
    return;
  }
  if (isCounterOffer && message.length < 10) {
    setNotice("applicationNotice", "Beskriv motbudet med minst tio tecken.", "error");
    return;
  }
  if (isCounterOffer && !proposedPrice) {
    setNotice("applicationNotice", "Ange ett giltigt motbud.", "error");
    return;
  }
  if (isCounterOffer && proposedPrice === Number(job.budget_sek)) {
    setNotice("applicationNotice", "Motbudet är samma som annonspriset. Välj Ta jobbet istället.", "error");
    return;
  }
  const defaultButtonText = isCounterOffer ? "Skicka motbud" : "Ta jobbet";
  setLoading("applicationSubmitBtn", true, isCounterOffer ? "Skickar motbud…" : "Tar jobbet…", defaultButtonText);
  const { error } = isCounterOffer
    ? await supabaseClient.from("job_applications").insert({
      job_id: selectedApplicationJobId,
      performer_id: currentUser.id,
      message,
      proposed_price_sek: proposedPrice
    })
    : await supabaseClient.rpc("claim_open_job", {
      p_job_id: selectedApplicationJobId,
      p_message: message
    });
  setLoading("applicationSubmitBtn", false, isCounterOffer ? "Skickar motbud…" : "Tar jobbet…", defaultButtonText);
  if (error) {
    const duplicate = error.code === "23505";
    const unavailable = !isCounterOffer && /JOB_UNAVAILABLE/i.test(error.message || "");
    if (unavailable) {
      await loadPublicJobs();
      setNotice("applicationNotice", "Någon annan hann ta jobbet, eller så är det inte längre öppet.", "error");
      return;
    }
    setNotice("applicationNotice", duplicate ? "Du har redan lämnat ett motbud på det här jobbet." : isCounterOffer ? "Motbudet kunde inte skickas." : "Jobbet kunde inte tas. Försök igen.", "error");
    return;
  }
  if (!isCounterOffer) {
    publicJobs = publicJobs.filter((item) => Number(item.id) !== Number(selectedApplicationJobId));
    applyJobFilters();
    const submitButton = byId("applicationSubmitBtn");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Jobbet är ditt";
    }
    setNotice("applicationNotice", "Jobbet är ditt! Chatten finns nu under Mina jobb.", "success");
    await loadNotifications();
    window.setTimeout(() => { window.location.href = "konto.html#jobs"; }, 1100);
    return;
  }
  byId("applicationForm").reset();
  updateApplicationOfferChoice();
  setNotice("applicationNotice", "Ditt motbud är skickat. Jobbet är öppet tills beställaren accepterar.", "success");
  await loadNotifications();
  window.setTimeout(closeApplicationModal, 1400);
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
  closePerformerProfile();
  clearPendingAuthFlow();
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  ownJobs = [];
  assignedJobs = [];
  accountMessageConversations = [];
  selectedAccountConversationIndex = null;
  if (accountConversationRefreshTimer) window.clearInterval(accountConversationRefreshTimer);
  accountConversationRefreshTimer = null;
  notifications = [];
  jobAlerts = [];
  completedEarningsJobs = [];
  if (notificationRefreshTimer) window.clearInterval(notificationRefreshTimer);
  notificationRefreshTimer = null;
  updateAccountButton();
  closeAccountModal();
  if (isAccountPage()) {
    byId("accountPageLoading")?.classList.add("hidden");
    byId("accountPageContent")?.classList.add("hidden");
    byId("accountPageGuest")?.classList.remove("hidden");
  }
  if (byId("publicJobs")) renderPublicJobs(publicJobs);
}

async function initializeAuth() {
  if (supabaseClient) {
    const { data } = await supabaseClient.auth.getSession();
    currentUser = data.session?.user || null;
    if (currentUser) {
      clearPendingAuthFlow();
      await loadProfile();
    }
    updateAccountButton();
    startNotificationRefresh();
    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
      currentUser = session?.user || null;
      if (currentUser) {
        clearPendingAuthFlow();
        await loadProfile();
      }
      else {
        currentProfile = null;
        notifications = [];
      }
      updateAccountButton();
      startNotificationRefresh();
      if (isAccountPage() && authReady) {
        if (currentUser && currentProfile) await showAccountStep();
        else if (currentUser) openAccountModal("customer");
        else {
          byId("accountPageContent")?.classList.add("hidden");
          byId("accountPageGuest")?.classList.remove("hidden");
        }
      }
      if (byId("publicJobs")) renderPublicJobs(publicJobs);
    });
  }
  await loadEstablishedProfileBadges();
  if (byId("publicJobs")) await loadPublicJobs();
  if (byId("availablePerformers")) await loadAvailablePerformers();
  authReady = true;
  const params = new URLSearchParams(window.location.search);
  const editJobId = Number(params.get("editJob") || 0);
  if (editJobId) {
    pendingEditJobId = editJobId;
    if (currentUser && currentProfile) await openEditJob(editJobId);
    else openAccountModal("customer");
  } else if (params.get("newJob") === "1") {
    pendingJob = true;
    openModal("job");
  } else if (!currentUser) {
    restorePendingLogin();
  }
  if (isAccountPage()) {
    if (currentUser && currentProfile) await showAccountStep();
    else if (currentUser) openAccountModal("customer");
    else {
      byId("accountPageLoading")?.classList.add("hidden");
      byId("accountPageGuest")?.classList.remove("hidden");
    }
  }
}

function attachPageEvents() {
  window.addEventListener("maplibre-ready", () => {
    if (activeJobView === "map") renderJobsMap(visiblePublicJobs.length ? visiblePublicJobs : nearbyPublicJobs);
  });
  byId("modal")?.addEventListener("click", function (event) { if (event.target === this) closeModal(); });
  byId("accountModal")?.addEventListener("click", function (event) { if (event.target === this) closeAccountModal(); });
  byId("callbackModal")?.addEventListener("click", function (event) { if (event.target === this) closeCallbackModal(); });
  byId("applicationModal")?.addEventListener("click", function (event) { if (event.target === this) closeApplicationModal(); });
  document.querySelectorAll('input[name="applicationOfferType"]').forEach((input) => input.addEventListener("change", updateApplicationOfferChoice));
  byId("jobChatModal")?.addEventListener("click", function (event) { if (event.target === this) closeJobChat(); });
  byId("performerProfileModal")?.addEventListener("click", function (event) { if (event.target === this) closePerformerProfile(); });
  document.addEventListener("click", (event) => {
    const notificationCenter = byId("notificationCenter");
    const notificationButtons = [byId("notificationButton"), byId("accountNotificationButton")].filter(Boolean);
    if (notificationCenter && !notificationCenter.contains(event.target) && !notificationButtons.some((button) => button.contains(event.target))) closeNotificationCenter();
    const availabilityWrap = byId("availabilityMenuWrap");
    if (availabilityWrap && !availabilityWrap.contains(event.target)) closeAvailabilityMenu();
  });
  byId("authCode")?.addEventListener("input", (event) => {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
    if (event.target.value !== digits) event.target.value = digits;
    if (authAutoSubmitTimer) window.clearTimeout(authAutoSubmitTimer);
    if (digits.length === 6) {
      authAutoSubmitTimer = window.setTimeout(() => {
        if (byId("authCode")?.value.length === 6 && !byId("verifyCodeBtn")?.disabled) verifyLoginCode();
      }, 250);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (authReady && document.visibilityState === "visible" && !currentUser) restorePendingLogin();
  });
  window.addEventListener("pageshow", () => {
    if (authReady && !currentUser) restorePendingLogin();
  });
  byId("jobPriceType")?.addEventListener("change", updateJobPriceTypeFields);
  byId("jobWhen")?.addEventListener("change", updateJobDateRangeVisibility);
  byId("jobCategory")?.addEventListener("change", updateJobCategoryTip);
  byId("jobImages")?.addEventListener("change", handleJobImages);
  ["jobTitle", "description", "jobLocation", "jobBudget", "jobDateStart", "jobDateEnd"].forEach((id) => {
    byId(id)?.addEventListener("input", analyzeJobQuality);
  });
  byId("jobDateStart")?.addEventListener("change", () => {
    if (byId("jobDateEnd")) byId("jobDateEnd").min = byId("jobDateStart")?.value || "";
    analyzeJobQuality();
  });
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
  ["filterSearch", "filterCategory", "filterTiming", "filterMinBudget", "filterSort"].forEach((id) => {
    const element = byId(id);
    if (!element) return;
    const eventName = ["filterSearch", "filterMinBudget"].includes(id) ? "input" : "change";
    element.addEventListener(eventName, applyJobFilters);
  });
  byId("filterLocation")?.addEventListener("input", handleLocationFilterInput);
  byId("filterDistance")?.addEventListener("change", handleDistanceFilterChange);
  ["performerSearchFilter", "performerAreaFilter"].forEach((id) => {
    byId(id)?.addEventListener("input", applyPerformerFilters);
  });
}

attachPageEvents();
initializeAuth();
