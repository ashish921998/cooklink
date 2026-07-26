// PROTOTYPE — throwaway. Low-fidelity end-to-end V1 journey.
// Answers issue 08: does the synthesized spec cover the full journey well enough
// to hand to implementation? Where the spec is silent, a stage renders a "SPEC GAP"
// callout — that gap IS the finding.

/* ------------------------------------------------------------------ *
 * Synthesized V1 acceptance criteria (rolled up from issues 01–07).
 * Each stage declares which AC ids it demonstrates; the coverage overlay
 * shows hits (this stage) vs. the full measurable list.
 * ------------------------------------------------------------------ */
const ACCEPTANCE = {
  // First-use
  F1: { group: "First-use", text: "A new household gets an active 7-day B/L/D plan with no approval step." },
  F2: { group: "First-use", text: "A Cook joins only via a Household Invite; cannot self-create a household." },
  // Member
  M1: { group: "Member experience", text: "Member fresh launch opens Today with Today selected." },
  M2: { group: "Member experience", text: "Meal Plan and Groceries are one tap away; Chat is a header action, not a 4th tab." },
  // Cook
  C1: { group: "Cook multi-household", text: "Cook fresh launch opens the Household list even with one household." },
  C2: { group: "Cook multi-household", text: "Selecting a household opens Chat; exactly 3 persistent destinations." },
  C3: { group: "Cook multi-household", text: "Switching households never leaks prior household state." },
  // Plan editing
  P1: { group: "Automatic plan editing", text: "Swap, regenerate (meal/day/week), and search are available from Meal Plan." },
  P2: { group: "Automatic plan editing", text: "Cook edits apply immediately and are attributed; no Member approval." },
  P3: { group: "Automatic plan editing", text: "A stale plan suggestion cannot overwrite a newer meal without fresh confirmation (optimistic concurrency)." },
  // Recipe Guides
  R1: { group: "Recipe Guides", text: "Recipe Guide shows step-by-step text + on-demand voice in EN/HI, generated server-side." },
  // Chat
  H1: { group: "Chat", text: "Send text, one photo+caption, or one voice note ≤2 min." },
  H2: { group: "Chat", text: "An EN/HI message can produce a private suggestion visible only to its author." },
  H3: { group: "Chat", text: "'I need grocery' asks for the missing item; it does not create a request." },
  H4: { group: "Chat", text: "A confirmed action appends one attributed system event; edits never reverse a confirmed action." },
  H5: { group: "Chat", text: "Messages are editable/deletable only by their author within 15 minutes." },
  // Grocery Requests
  G1: { group: "Grocery Requests", text: "Cook can create a request; Member sees Approve/add-to-cart; Cook sees no price or checkout." },
  G2: { group: "Grocery Requests", text: "Either active Cook can edit/cancel a pending request; a concurrent conflict is rejected with current state shown." },
  // Estimated Pantry
  E1: { group: "Estimated Pantry", text: "Only likely available / may be low / unknown is shown — never exact stock." },
  E2: { group: "Estimated Pantry", text: "Delivered orders add pantry; checkout success alone does not." },
  E3: { group: "Estimated Pantry", text: "Cart covers today + next 2 calendar days; items labelled by need timing." },
  // Checkout + fallback
  I1: { group: "Instamart checkout & fallback", text: "No checkout without fresh Member confirmation + a server-side role check." },
  I2: { group: "Instamart checkout & fallback", text: "An idempotency key gates every attempt; an uncertain failure is resolved via get_orders before any retry; no duplicate order." },
  I3: { group: "Instamart checkout & fallback", text: "Cart ≥ ₹1000 or no payment method routes to the Instamart app; no deep link is promised." },
  I4: { group: "Instamart checkout & fallback", text: "Ordering is feature-gated; production ordering is unavailable until Swiggy grants access." },
  // Failures
  FL1: { group: "Failures", text: "An offline message stays in its household outbox, retries, and cannot leak cross-household or act before server acceptance." },
  FL2: { group: "Failures", text: "A removed participant immediately loses chat/media access." },
  // Accessibility + language
  A1: { group: "Accessibility & language", text: "Navigation is localized EN/HI; both are never shown simultaneously." },
  A2: { group: "Accessibility & language", text: "44pt targets, accessibility labels, and correct behavior at the largest text scale & 320px width." },
  // Security (cross-cutting)
  S1: { group: "Security (cross-cutting)", text: "Authorization is enforced in the app server on every request against (user, household, role); no RLS; client checks are nav-only." },
  S2: { group: "Security (cross-cutting)", text: "No provider secret lives in the bundle (CI grep test)." },
  S3: { group: "Security (cross-cutting)", text: "An authorization test suite proves no cross-household data access." },
};

/* ------------------------------------------------------------------ *
 * i18n — minimal dictionary to exercise EN/HI (low-literacy lens).
 * ------------------------------------------------------------------ */
const T = {
  today: { en: "Today", hi: "आज" },
  plan: { en: "Meal Plan", hi: "मील प्लान" },
  groceries: { en: "Groceries", hi: "किराना" },
  chat: { en: "Chat", hi: "चैट" },
  households: { en: "Households", hi: "घर" },
  back: { en: "Back", hi: "वापस" },
  recipe: { en: "Recipe", hi: "रेसिपी" },
  cookingNow: { en: "Cooking now", hi: "अभी बना रहे" },
};
const t = (k) => (T[k] ? T[k][state.lang] : k);

/* ------------------------------------------------------------------ *
 * State (URL-backed, reload-stable, in-memory only).
 * ------------------------------------------------------------------ */
const state = {
  stage: "firstuse-welcome",
  lang: "en",
  coverage: false,
  // ephemeral toggles inside stages
  onboard: { style: "south", diet: "veg", servings: "3" },
  planConflict: false,
  recipeVoice: false,
  intentConfirmed: false,
  requestApproved: false,
  cart: { coconut: true, coriander: true, oil: true, rice: false },
  checkout: "review", // review | confirm | success | fallback
};

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  if (p.get("stage")) state.stage = p.get("stage");
  if (p.get("lang") === "hi") state.lang = "hi";
  if (p.get("coverage") === "1") state.coverage = true;
}

function writeUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("stage", state.stage);
  url.searchParams.set("lang", state.lang);
  url.searchParams.set("coverage", state.coverage ? "1" : "0");
  window.history.replaceState({}, "", url);
}

/* ------------------------------------------------------------------ *
 * Icons (subset of the nav prototype set + a few extras).
 * ------------------------------------------------------------------ */
function icon(name, size = 22) {
  const paths = {
    back: '<path d="m15 18-6-6 6-6"/><path d="M9 12h10"/>',
    calendar: '<rect width="17" height="16" x="3.5" y="5" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    chat: '<path d="M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    groceries: '<path d="M6 8h12l1 13H5L6 8Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
    meal: '<path d="M6 3v8M3 3v5a3 3 0 0 0 6 0V3M6 11v10M16 3v18M16 3c3 2 4 5 4 8h-4"/>',
    mic: '<rect width="8" height="13" x="8" y="2" rx="4"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    plan: '<rect width="18" height="18" x="3" y="3" rx="3"/><path d="M8 2v3M16 2v3M3 9h18M8 13h3M8 17h7"/>',
    play: '<path d="m6 4 14 8-14 8z"/>',
    pause: '<path d="M8 4v16M16 4v16"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    swap: '<path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/>',
    today: '<path d="M4 5h16v16H4zM8 3v4M16 3v4M4 10h16"/><path d="m9 15 2 2 4-4"/>',
    warning: '<path d="M12 3 2 21h20Z"/><path d="M12 9v5M12 17h.01"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
}

/* ------------------------------------------------------------------ *
 * Shell + chrome.
 * ------------------------------------------------------------------ */
function phoneShell(content, extraClass = "") {
  const bigtext = state.stage === "a11y-hindi" ? "bigtext" : "";
  return `
    <main class="prototype-stage">
      <div class="phone-frame ${bigtext}">
        <div class="phone-status"><span>9:41</span><span class="status-glyphs">● ◒ ▰</span></div>
        <section class="phone-screen ${state.lang === "hi" ? "hindi" : ""}">${content}</section>
        <div class="home-indicator"></div>
      </div>
    </main>
  `;
}

function bottomNav(active) {
  const items = [
    ["today", "today", "today"],
    ["plan", "plan", "plan"],
    ["groceries", "groceries", "groceries", 2],
  ];
  return `
    <nav class="bottom-nav" aria-label="Primary navigation">
      ${items
        .map(
          ([s, key, ic, count]) => `
        <button class="${active === s ? "active" : ""}" aria-current="${active === s ? "page" : "false"}">
          <span class="nav-icon">${icon(ic)}${count ? `<i>${count}</i>` : ""}</span>
          <span>${t(key)}</span>
        </button>`,
        )
        .join("")}
    </nav>
  `;
}

function cookBottomNav(active) {
  const items = [
    ["chat", "chat", "chat"],
    ["plan", "plan", "plan"],
    ["groceries", "groceries", "groceries", 1],
  ];
  return `
    <nav class="bottom-nav" aria-label="Primary navigation">
      ${items
        .map(
          ([s, key, ic, count]) => `
        <button class="${active === s ? "active" : ""}" aria-current="${active === s ? "page" : "false"}">
          <span class="nav-icon">${icon(ic)}${count ? `<i>${count}</i>` : ""}</span>
          <span>${t(key)}</span>
        </button>`,
        )
        .join("")}
    </nav>
  `;
}

function gap(text) {
  return `
    <div class="gap-callout" role="note">
      <span class="gap-label">${icon("warning", 12)} Spec gap surfaced by this stage</span>
      <p>${text}</p>
    </div>
  `;
}

function memberHeader({ title, eyebrow = "Rao Family", back = false }) {
  return `
    <header class="app-header">
      <div class="header-title">
        ${back ? `<button class="icon-button" aria-label="${t("back")}">${icon("back")}</button>` : ""}
        <div>${back ? "" : `<span class="eyebrow">${eyebrow}</span>`}<h1>${title}</h1></div>
      </div>
      <button class="icon-button has-dot" aria-label="Open ${t("chat")}">${icon("chat")}</button>
    </header>
  `;
}

function cookChatHeader({ title = "Rao Family", sub = "3 Members" }) {
  return `
    <header class="chat-header">
      <button class="icon-button" aria-label="${t("back")}">${icon("back")}</button>
      <span class="avatar mango">AR</span>
      <div style="min-width:0"><h1>${title}</h1><small>${sub}</small></div>
      <button class="icon-button" aria-label="Options">${icon("more")}</button>
    </header>
  `;
}

/* ------------------------------------------------------------------ *
 * Shared content blocks.
 * ------------------------------------------------------------------ */
function mealList({ recipeOn = true } = {}) {
  const meals = [
    { time: { en: "Breakfast", hi: "नाश्ता" }, meal: { en: "Vegetable poha", hi: "सब्जी पोहा" }, meta: "8:00 AM · 3", emoji: "🥣", tone: "yellow" },
    { time: { en: "Lunch", hi: "दोपहर" }, meal: { en: "Sambar rice", hi: "सांबर चावल" }, meta: "1:00 PM · 3", emoji: "🍛", tone: "orange" },
    { time: { en: "Dinner", hi: "रात" }, meal: { en: "Palak paneer", hi: "पालक पनीर" }, meta: "8:00 PM · 4", emoji: "🥬", tone: "green" },
  ];
  return `
    <div class="meal-list">
      ${meals
        .map(
          (m, i) => `
        <article class="meal-row">
          <span class="meal-visual ${m.tone}">${m.emoji}</span>
          <div class="meal-copy">
            <span class="meal-time">${m.time[state.lang]}</span>
            <strong>${m.meal[state.lang]}</strong>
            <small>${m.meta} ${state.lang === "hi" ? "लोग" : "people"}</small>
          </div>
          ${recipeOn && i === 1 ? `<button class="mini-action" data-jump="recipe-guide">${t("recipe")} ${icon("chevron", 16)}</button>` : `<span style="color:#9fa7a1">${icon("chevron", 18)}</span>`}
        </article>`,
        )
        .join("")}
    </div>
  `;
}

/* ================================================================== *
 * STAGES
 * ================================================================== */
const STAGES = [
  /* ---- First-use ---- */
  {
    key: "firstuse-welcome", section: "First-use", role: "Member",
    title: { en: "Create your household", hi: "अपना घर बनाएँ" },
    acs: ["F1"],
    render: () => `
      <header class="app-header"><div class="header-title"><div><span class="eyebrow">Cooklink</span><h1>${state.lang === "hi" ? "स्वागत है" : "Welcome"}</h1></div></div></header>
      <div class="screen-scroll inset">
        <div class="stepper"><i class="done"></i><i></i><i></i></div>
        <div class="onboard-card">
          <h3>${state.lang === "hi" ? "घर का नाम" : "Household name"}</h3>
          <input style="width:100%;border:1px solid var(--line);border-radius:12px;padding:11px;margin-top:9px;font-size:13px" value="Rao Family" />
        </div>
        <div class="onboard-card">
          <h3>${state.lang === "hi" ? "खाने का स्टाइल" : "Meal style"}</h3>
          <small>${state.lang === "hi" ? "घर के खाने का अंदाज" : "Home-cooking pattern"}</small>
          <div class="choice-row">
            <button class="choice ${state.onboard.style === "south" ? "selected" : ""}" data-toggle="style" data-val="south">${state.lang === "hi" ? "दक्षिण भारतीय" : "South Indian"}</button>
            <button class="choice ${state.onboard.style === "north" ? "selected" : ""}" data-toggle="style" data-val="north">${state.lang === "hi" ? "उत्तर भारतीय" : "North Indian"}</button>
          </div>
        </div>
        <div class="onboard-card">
          <h3>${state.lang === "hi" ? "खाने का प्रकार" : "Diet style"}</h3>
          <div class="choice-row">
            <button class="choice ${state.onboard.diet === "veg" ? "selected" : ""}" data-toggle="diet" data-val="veg">${state.lang === "hi" ? "शाकाहारी" : "Vegetarian"}</button>
            <button class="choice ${state.onboard.diet === "egg" ? "selected" : ""}" data-toggle="diet" data-val="egg">${state.lang === "hi" ? "अंडा" : "Eggetarian"}</button>
            <button class="choice ${state.onboard.diet === "nonveg" ? "selected" : ""}" data-toggle="diet" data-val="nonveg">${state.lang === "hi" ? "मांसाहारी" : "Non-veg"}</button>
          </div>
        </div>
        <div class="onboard-card">
          <h3>${state.lang === "hi" ? "कितने लोग खाते हैं?" : "How many diners?"}</h3>
          <div class="choice-row">
            ${["2", "3", "4", "5", "6"].map((n) => `<button class="choice ${state.onboard.servings === n ? "selected" : ""}" data-toggle="servings" data-val="${n}">${n}</button>`).join("")}
          </div>
        </div>
        ${gap(state.lang === "hi"
          ? "स्पेक में यह स्पष्ट नहीं है कि नया घर बनाने वाला पहला सदस्य कौन बनता है (Household Owner) और फ़ोन नंबर की पुष्टि के बाद यह स्क्रीन कैसे खुलती है।"
          : "The spec doesn't say who the first person becomes (Household Owner) or how this screen is reached after phone-OTP verification. The Household Invite acceptance path for a joining Member is also undefined.")}
        <button class="btn-primary" data-advance>${state.lang === "hi" ? "आगे बढ़ें" : "Continue"} ${icon("chevron", 18)}</button>
      </div>
    `,
  },
  {
    key: "firstuse-plan", section: "First-use", role: "Member",
    title: { en: "Plan appears — no approval", hi: "प्लान तुरंत तैयार" },
    acs: ["F1", "M1"],
    render: () => `
      <header class="app-header"><div class="header-title"><div><span class="eyebrow">Rao Family</span><h1>${t("today")}</h1></div></div>
        <button class="icon-button" aria-label="Open ${t("chat")}">${icon("chat")}</button></header>
      <div class="screen-scroll inset">
        <div class="magic-banner">
          <span class="glyph">✨</span>
          <div><b>${state.lang === "hi" ? "इस हफ़्ते का प्लान तैयार है" : "This week's plan is ready"}</b>
          <small>${state.lang === "hi" ? "बिना मंज़ूरी — बदलें जब चाहें" : "No approval needed — edit anytime"}</small></div>
        </div>
        <div class="date-line" style="display:flex;justify-content:space-between;margin:0 0 14px;padding:10px 13px;border-radius:12px;background:#edf4e4;color:#385544;font-size:11px"><b>${state.lang === "hi" ? "मंगल, 25 जुलाई" : "Tuesday, 25 July"}</b><span>${state.lang === "hi" ? "3 वक़्त · 3 लोग" : "3 meals · 3 people"}</span></div>
        ${mealList()}
        ${gap(state.lang === "hi"
          ? "'first-use magic' का मापने योग्य लक्ष्य (जैसे 'पहली प्लान T+10s में') स्पेक में नहीं है।"
          : "There is no measurable 'first-use magic' target in the spec (e.g. 'first plan generated within T+10s of setup'). 'Magic' is asserted, not testable.")}
      </div>
      ${bottomNav("today")}
    `,
  },
  {
    key: "firstuse-invite", section: "First-use", role: "Member",
    title: { en: "Invite your cook", hi: "अपने रसोईये को बुलाएँ" },
    acs: ["F2"],
    render: () => `
      ${memberHeader({ title: state.lang === "hi" ? "रसोईया जोड़ें" : "Add your Cook", back: true })}
      <div class="screen-scroll inset">
        <div class="status-screen" style="flex:0;padding:20px 0">
          <div class="glyph">👨‍🍳</div>
          <h2 style="font-size:20px">${state.lang === "hi" ? "व्हाट्सऐप पर लिंक भेजें" : "Send the link on WhatsApp"}</h2>
          <p>${state.lang === "hi"
            ? "आपके रसोईये को एक Household Invite मिलेगा। वह लिंक खोलकर Cook के रूप में जुड़ जाएँगे।"
            : "Your Cook gets a Household Invite. They open the link and join as the Cook."}</p>
        </div>
        <button class="btn-primary" style="background:#25D366">${icon("chat", 18)} ${state.lang === "hi" ? "व्हाट्सऐप पर भेजें" : "Send on WhatsApp"}</button>
        ${gap(state.lang === "hi"
          ? "Household Invite के स्वीकार होने का flow स्पेक में नहीं है: रसोईये का फ़ोन नंबर कैसे जुड़ता है, दो रसोईयों की सीमा कैसे लागू होती है, और पहले से Cooklink इस्तेमाल करते रसोईये के लिए क्या होता है — सब अनिर्धारित है।"
          : "The Household Invite acceptance flow is unspecified: how the Cook's phone number gets bound, how the two-Cook cap is enforced, and what happens for a Cook who already uses Cooklink (cross-household onboarding) are all undefined.")}
      </div>
    `,
  },

  /* ---- Member core loop ---- */
  {
    key: "member-today", section: "Member loop", role: "Member",
    title: { en: "Today's meals", hi: "आज के खाने" },
    acs: ["M1", "M2", "R1"],
    render: () => `
      ${memberHeader({ title: t("today") })}
      <div class="screen-scroll">
        <div class="date-line" style="display:flex;justify-content:space-between;margin:0 0 14px;padding:10px 13px;border-radius:12px;background:#edf4e4;color:#385544;font-size:11px"><b>${state.lang === "hi" ? "मंगल, 25 जुलाई" : "Tuesday, 25 July"}</b><span>3 ${state.lang === "hi" ? "वक़्त" : "meals"} · 3</span></div>
        ${mealList()}
      </div>
      ${bottomNav("today")}
    `,
  },
  {
    key: "member-plan", section: "Member loop", role: "Member",
    title: { en: "Meal Plan — edit tools", hi: "मील प्लान — बदलाव" },
    acs: ["P1", "P2"],
    render: () => `
      ${memberHeader({ title: t("plan") })}
      <div class="screen-scroll">
        <div class="week-strip">
          <button class="selected"><b>${state.lang === "hi" ? "मंगल" : "Tue"}</b><small>25</small></button>
          <button><b>${state.lang === "hi" ? "बुध" : "Wed"}</b><small>26</small></button>
          <button><b>${state.lang === "hi" ? "गुरु" : "Thu"}</b><small>27</small></button>
          <button><b>${state.lang === "hi" ? "शुक्र" : "Fri"}</b><small>28</small></button>
          <button><b>${state.lang === "hi" ? "शनि" : "Sat"}</b><small>29</small></button>
        </div>
        <article class="plan-day active">
          <div class="day-label"><b>${state.lang === "hi" ? "मंगल" : "Tue"}</b><small>25 July</small></div>
          <div class="day-meals">
            <div class="meal-slot"><span><small>${state.lang === "hi" ? "नाश्ता" : "B'fast"}</small> ${state.lang === "hi" ? "सब्जी पोहा" : "Veg poha"}</span>
              <span class="slot-actions"><button class="chip-action">${icon("swap", 12)} ${state.lang === "hi" ? "बदलें" : "Swap"}</button><button class="chip-action">${icon("refresh", 12)}</button></span></div>
            <div class="meal-slot"><span><small>${state.lang === "hi" ? "दोपहर" : "Lunch"}</small> ${state.lang === "hi" ? "सांबर चावल" : "Sambar rice"}</span>
              <span class="slot-actions"><button class="chip-action">${icon("swap", 12)}</button><button class="chip-action">${icon("search", 12)}</button><button class="chip-action">${icon("refresh", 12)}</button></span></div>
            <div class="meal-slot"><span><small>${state.lang === "hi" ? "रात" : "Dinner"}</small> ${state.lang === "hi" ? "पालक पनीर" : "Palak paneer"}</span>
              <span class="slot-actions"><button class="chip-action">${icon("swap", 12)}</button><button class="chip-action">${icon("refresh", 12)}</button></span></div>
          </div>
        </article>
        <button class="btn-secondary">${icon("refresh", 16)} ${state.lang === "hi" ? "बाकी हफ़्ता फिर से बनाएँ" : "Regenerate the rest of the week"}</button>
      </div>
      ${bottomNav("plan")}
    `,
  },
  {
    key: "member-edit-conflict", section: "Member loop", role: "Member",
    title: { en: "Plan edit — concurrency conflict", hi: "बदलाव — टकराव" },
    acs: ["P3"],
    render: () => `
      ${memberHeader({ title: t("plan"), back: true })}
      <div class="screen-scroll">
        <p style="font-size:11px;color:var(--muted);margin:4px 0 12px">${state.lang === "hi"
          ? "आपने दोपहर का खाना बदलने की कोशिश की। तब तक लक्ष्मी (रसोईये) ने वह बदल दिया।"
          : "You tried to change lunch. Meanwhile Lakshmi (Cook) changed it."}</p>
        <article class="plan-day active" style="border-color:#e6b9ad">
          <div class="day-label"><b>${state.lang === "hi" ? "दोपहर" : "Lunch"}</b></div>
          <div class="day-meals">
            <div class="meal-slot"><span style="font-size:13px">${state.lang === "hi" ? "अब: राजमा चावल" : "Now: Rajma rice"}</span></div>
            <small style="color:var(--rust);font-size:9px">${state.lang === "hi" ? "लक्ष्मी ने 2 मिनट पहले बदला" : "Lakshmi changed this 2 min ago"}</small>
          </div>
        </article>
        <div class="confirm-sheet" style="border-color:#e6b9ad;background:#fbeee9">
          <b>${state.lang === "hi" ? "अभी भी सांबर चावल चाहिए?" : "Still want Sambar rice?"}</b>
          <small>${state.lang === "hi" ? "नया बदलाव पुष्टि के बाद ही लगेगा" : "Your change applies only after you confirm again"}</small>
        </div>
        <button class="btn-primary">${state.lang === "hi" ? "पक्का करें" : "Confirm anyway"}</button>
        <button class="btn-secondary">${state.lang === "hi" ? "नया खाना रखें" : "Keep the new meal"}</button>
      </div>
    `,
  },
  {
    key: "recipe-guide", section: "Member loop", role: "Cook",
    title: { en: "Recipe Guide (text + voice)", hi: "रेसिपी गाइड" },
    acs: ["R1"],
    render: () => `
      ${cookChatHeader({ title: state.lang === "hi" ? "सांबर चावल" : "Sambar rice", sub: state.lang === "hi" ? "रेसिपी गाइड" : "Recipe Guide" })}
      <div class="screen-scroll">
        <div class="recipe-hero">
          <span class="eyebrow">${state.lang === "hi" ? "दोपहर · 3 लोग" : "Lunch · 3 servings"}</span>
          <h2>${state.lang === "hi" ? "सांबर चावल" : "Sambar rice"}</h2>
          <small>${state.lang === "hi" ? "लगभग 45 मिनट" : "About 45 minutes"}</small>
          <div class="voice-bar">
            <button data-toggle="voice" aria-label="Play voice">${state.recipeVoice ? icon("pause", 16) : icon("play", 16)}</button>
            <span>${state.recipeVoice ? (state.lang === "hi" ? "चल रहा है… 0:12" : "Playing… 0:12") : (state.lang === "hi" ? "आवाज़ में सुनें" : "Listen as voice")}</span>
          </div>
        </div>
        <div class="recipe-step"><b>1</b><div><p>${state.lang === "hi" ? "तूर दाल 20 मिनट तक उबालें जब तक नरम न हो।" : "Boil toor dal for 20 minutes until soft."}</p><small>${state.lang === "hi" ? "सर्वर पर ElevenLabs से बनी" : "Generated server-side by ElevenLabs"}</small></div></div>
        <div class="recipe-step"><b>2</b><div><p>${state.lang === "hi" ? "सांबर पाउडर, हल्दी, और सब्जियाँ डालें।" : "Add sambar powder, turmeric, and vegetables."}</p></div></div>
        <div class="recipe-step"><b>3</b><div><p>${state.lang === "hi" ? "चावल अलग से पकाएँ और सांबर के साथ मिलाएँ।" : "Cook rice separately and combine with sambar."}</p></div></div>
        ${gap(state.lang === "hi"
          ? "रेसिपी के चरणों का स्रोत स्पेक में तय नहीं है: क्या ये AI से बनते हैं, curated database से, या Cook द्वारा लिखे जाते हैं? सामग्री की गुणवत्ता और सटीकता का मानक अनिर्धारित है।"
          : "The Recipe Guide content model is unspecified: are steps AI-generated, from a curated recipe database, or Cook-authored? The source, accuracy standard, and Serving-Count scaling of steps are undefined. The spec only fixes the delivery channel (text + on-demand TTS), not the content.")}
      </div>
    `,
  },

  /* ---- Chat ---- */
  {
    key: "chat", section: "Chat", role: "Member",
    title: { en: "Chat — text, photo, voice", hi: "चैट" },
    acs: ["H1", "H4", "H5"],
    render: () => `
      ${cookChatHeader({ title: "Rao Family", sub: state.lang === "hi" ? "रसोईये ऑनलाइन" : "Cook online" })}
      <div class="chat-log">
        <div class="day-chip">${state.lang === "hi" ? "आज" : "Today"}</div>
        <div class="message">${state.lang === "hi" ? "सुप्रभात! दोपहर 11 बजे शुरू करती हूँ।" : "Good morning! I'm starting lunch at 11."}<small>8:10</small></div>
        <div class="system-message">${icon("plan", 14)} ${state.lang === "hi" ? "दोपहर बदला: सांबर चावल" : "Lunch changed to Sambar rice"} <b>· Lakshmi</b></div>
        <div class="message outgoing">${state.lang === "hi" ? "ठीक है। आज थोड़ा कम मिर्च डालें।" : "Perfect. Please make it less spicy today."}<small>8:18 ✓✓</small></div>
        <div class="photo-msg outgoing"><div class="photo-box">🥘</div><div class="caption">${state.lang === "hi" ? "यह ठीक है?" : "Is this ok?"}</div></div>
        <div class="voice-message"><button aria-label="Play">${icon("play", 16)}</button><span class="voice-line"></span><b>0:18</b><small>8:40</small></div>
        <div class="system-message grocery">${icon("groceries", 14)} ${state.lang === "hi" ? "नई माँग: ताज़ा नारियल" : "New request: Fresh coconut"} <b>· Lakshmi</b></div>
      </div>
      <form class="composer" onsubmit="return false">
        <button type="button" aria-label="Record voice note">${icon("mic")}</button>
        <input aria-label="Message" placeholder="${state.lang === "hi" ? "संदेश" : "Message"}" />
        <button type="button" class="send" aria-label="Send">${icon("chat", 19)}</button>
      </form>
    `,
  },
  {
    key: "chat-intent", section: "Chat", role: "Member",
    title: { en: "Chat — private intent suggestion", hi: "चैट — सुझाव" },
    acs: ["H2", "H3", "H4"],
    render: () => `
      ${cookChatHeader({ title: "Rao Family", sub: state.lang === "hi" ? "सिर्फ़ आपको दिखेगा" : "Private to you" })}
      <div class="chat-log">
        <div class="message outgoing">${state.lang === "hi" ? "मुझे किराना चाहिए" : "I need grocery"}<small>9:02 ✓✓</small></div>
        <div class="suggestion">
          <span class="tag">${state.lang === "hi" ? "सिर्फ़ आपको" : "Private to you"}</span>
          <b>${state.lang === "hi" ? "क्या चाहिए?" : "What do you need?"}</b>
          <small>${state.lang === "hi" ? "एक चीज़ बताएँ ताकि माँग बन सके" : "Name one item so I can create the request"}</small>
          <input style="width:100%;border:1px solid var(--line);border-radius:10px;padding:9px;margin-bottom:8px;font-size:11px" value="${state.lang === "hi" ? "नारियल" : "Coconut"}" />
        </div>
        ${state.intentConfirmed ? `
          <div class="suggestion">
            <span class="tag">${state.lang === "hi" ? "सिर्फ़ आपको" : "Private to you"}</span>
            <b>${state.lang === "hi" ? "सुझाव: किराने में नारियल जोड़ें" : "Suggestion: Add Coconut to Suggested Cart"}</b>
            <small>${state.lang === "hi" ? "पुष्टि के बाद सबको दिखेगा" : "Visible to everyone after you confirm"}</small>
            <div class="actions">
              <button class="primary" data-toggle="intentConfirmed">${state.lang === "hi" ? "किराने में जोड़ें" : "Add to cart"}</button>
              <button class="ghost">${state.lang === "hi" ? "नहीं चाहिए" : "Dismiss"}</button>
            </div>
          </div>
          <div class="system-message">${icon("groceries", 14)} ${state.lang === "hi" ? "किराने में जोड़ा: नारियल" : "Added to cart: Coconut"} <b>· You</b></div>
        ` : `
          <div class="suggestion">
            <span class="tag">${state.lang === "hi" ? "सिर्फ़ आपको" : "Private to you"}</span>
            <b>${state.lang === "hi" ? "सुझाव: किराने में नारियल जोड़ें" : "Suggestion: Add Coconut to Suggested Cart"}</b>
            <small>${state.lang === "hi" ? "आप सदस्य हैं — सीधे किराने में जोड़ें (खरीदारी की मंज़ूरी अलग)" : "As a Member this adds to your cart (checkout is a separate confirmation)"}</small>
            <div class="actions">
              <button class="primary" data-toggle="intentConfirmed">${state.lang === "hi" ? "किराने में जोड़ें" : "Add to cart"}</button>
              <button class="ghost">${state.lang === "hi" ? "नहीं चाहिए" : "Dismiss"}</button>
            </div>
          </div>
        `}
      </div>
      <form class="composer" onsubmit="return false">
        <button type="button" aria-label="Record">${icon("mic")}</button>
        <input aria-label="Message" placeholder="${state.lang === "hi" ? "संदेश" : "Message"}" />
        <button type="button" class="send" aria-label="Send">${icon("chat", 19)}</button>
      </form>
    `,
  },
  {
    key: "chat-approve", section: "Chat", role: "Member",
    title: { en: "Chat — approve Cook request", hi: "चैट — माँग मंज़ूर" },
    acs: ["G1", "H4"],
    render: () => `
      ${cookChatHeader({ title: "Rao Family", sub: state.lang === "hi" ? "रसोईये ऑनलाइन" : "Cook online" })}
      <div class="chat-log">
        <div class="voice-message"><button aria-label="Play">${icon("play", 16)}</button><span class="voice-line"></span><b>0:09</b><small>9:30</small></div>
        <div class="live-card">
          <div class="lc-head">
            <span class="state-pill ${state.requestApproved ? "approved" : "waiting"}">${state.requestApproved ? (state.lang === "hi" ? "मंज़ूर" : "Approved") : (state.lang === "hi" ? "इंतज़ार" : "Waiting")}</span>
            <b>${state.lang === "hi" ? "ताज़ा नारियल — बुध के दोपहर के लिए" : "Fresh coconut — for Wednesday lunch"}</b>
            <small>${state.lang === "hi" ? "लक्ष्मी ने माँगी · आज" : "Requested by Lakshmi · today"}</small>
          </div>
          <div class="lc-actions">
            <button class="${state.requestApproved ? "no" : "yes"}" data-toggle="requestApproved">${state.requestApproved ? (state.lang === "hi" ? "वापस लें" : "Undo") : (state.lang === "hi" ? "मंज़ूर करें" : "Approve &amp; add to cart")}</button>
            ${state.requestApproved ? "" : `<button class="no">${state.lang === "hi" ? "नहीं" : "Reject"}</button>`}
          </div>
        </div>
        ${state.requestApproved ? `<div class="system-message grocery">${icon("check", 14)} ${state.lang === "hi" ? "माँग मंज़ूर: नारियल किराने में जोड़ा" : "Request approved: Coconut added to cart"} <b>· You</b></div>` : ""}
      </div>
      <form class="composer" onsubmit="return false">
        <button type="button" aria-label="Record">${icon("mic")}</button>
        <input aria-label="Message" placeholder="${state.lang === "hi" ? "संदेश" : "Message"}" />
        <button type="button" class="send" aria-label="Send">${icon("chat", 19)}</button>
      </form>
    `,
  },

  /* ---- Cook multi-household ---- */
  {
    key: "cook-list", section: "Cook loop", role: "Cook",
    title: { en: "Cook — household list", hi: "रसोईये — घर" },
    acs: ["C1", "C3"],
    render: () => {
      const households = [
        { id: "rao", initials: "AR", name: "Rao Family", colour: "mango", next: state.lang === "hi" ? "दोपहर · सांबर चावल" : "Lunch · Sambar rice", msg: state.lang === "hi" ? "आज कम मिर्च" : "Less spicy today", time: "8:42", unread: 2 },
        { id: "mehta", initials: "SM", name: "Mehta Home", colour: "sage", next: state.lang === "hi" ? "रात · पालक पनीर" : "Dinner · Palak paneer", msg: state.lang === "hi" ? "माँग मंज़ूर" : "Request approved", time: state.lang === "hi" ? "कल" : "Yesterday", unread: 0 },
        { id: "iyer", initials: "VI", name: "Iyer Household", colour: "blue", next: state.lang === "hi" ? "दोपहर · नींबू चावल" : "Lunch · Lemon rice", msg: state.lang === "hi" ? "फ़ोटो" : "Photo", time: state.lang === "hi" ? "कल" : "Yesterday", unread: 0 },
        { id: "khan", initials: "AK", name: "Khan Family", colour: "rose", next: state.lang === "hi" ? "रात · चिकन पुलाव" : "Dinner · Chicken pulao", msg: state.lang === "hi" ? "आवाज़ · 0:18" : "Voice · 0:18", time: state.lang === "hi" ? "सोम" : "Mon", unread: 0 },
      ];
      return `
        <section class="household-list">
          <header class="list-header"><div><span class="eyebrow">${state.lang === "hi" ? "मंगल, 25 जुलाई" : "Tuesday, 25 July"}</span><h1>${t("households")}</h1></div>
            <button class="icon-button" aria-label="Options">${icon("more")}</button></header>
          <label class="search-box">${icon("search", 19)}<input aria-label="${state.lang === "hi" ? "घर खोजें" : "Search households"}" placeholder="${state.lang === "hi" ? "घर खोजें" : "Search households"}" /></label>
          <div class="household-rows">
            ${households.map((h) => `
              <button class="household-row" data-jump="cook-chat">
                <span class="avatar ${h.colour}">${h.initials}</span>
                <span class="household-copy">
                  <span class="row-top"><b>${h.name}</b><small>${h.time}</small></span>
                  <span class="next-meal">${h.next}</span>
                  <span class="message-preview">${h.msg}</span>
                </span>
                ${h.unread ? `<span class="unread">${h.unread}</span>` : ""}
              </button>`).join("")}
          </div>
        </section>
      `;
    },
  },
  {
    key: "cook-chat", section: "Cook loop", role: "Cook",
    title: { en: "Cook — chat-first + Daily Cook View", hi: "रसोईये — चैट" },
    acs: ["C2", "R1"],
    render: () => `
      ${cookChatHeader({ title: "Rao Family", sub: state.lang === "hi" ? "3 सदस्य" : "3 Members" })}
      <button class="pinned-meal" data-jump="recipe-guide">
        <span>🍛</span><span><small>${t("cookingNow")}</small><b>${state.lang === "hi" ? "सांबर चावल · 3 लोग" : "Sambar rice · 3 people"}</b></span>${icon("chevron", 18)}
      </button>
      <div class="chat-log">
        <div class="day-chip">${state.lang === "hi" ? "आज" : "Today"}</div>
        <div class="message outgoing">${state.lang === "hi" ? "सुप्रभात! 11 बजे शुरू करती हूँ।" : "Good morning! Starting lunch at 11."}<small>8:10 ✓✓</small></div>
        <div class="message">${state.lang === "hi" ? "ठीक है। थोड़ी कम मिर्च।" : "Ok. A bit less spice."}<small>8:18</small></div>
      </div>
      <form class="composer" onsubmit="return false">
        <button type="button" aria-label="Record">${icon("mic")}</button>
        <input aria-label="Message" placeholder="${state.lang === "hi" ? "संदेश" : "Message"}" />
        <button type="button" class="send" aria-label="Send">${icon("chat", 19)}</button>
      </form>
      ${cookBottomNav("chat")}
    `,
  },
  {
    key: "cook-request", section: "Cook loop", role: "Cook",
    title: { en: "Cook — create grocery request", hi: "रसोईये — किराने की माँग" },
    acs: ["G1", "G2"],
    render: () => `
      ${cookChatHeader({ title: "Rao Family", sub: state.lang === "hi" ? "किराना" : "Groceries" })}
      <div class="screen-scroll inset">
        <div class="cook-today-title" style="margin:4px 0 14px"><span class="eyebrow">Rao Family</span><h2 style="font-family:'DM Serif Display',serif;font-size:24px;font-weight:400;margin:3px 0 0">${state.lang === "hi" ? "किराने की माँग" : "Grocery requests"}</h2></div>
        <button class="new-request" style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:11px;width:100%;border:0;border-radius:16px;padding:14px;color:#fff;text-align:left;background:var(--leaf);cursor:pointer">${icon("mic", 23)}<span><b>${state.lang === "hi" ? "किराना माँगें" : "Ask for a grocery"}</b><small style="display:block;margin-top:3px;color:#cee0d2;font-size:9px">${state.lang === "hi" ? "बोलें या लिखें क्या कम है" : "Speak or type what's missing"}</small></span>${icon("chevron", 18)}</button>
        <div class="request-list" style="display:grid;gap:10px;margin-top:14px">
          <article style="padding:14px;border:1px solid var(--line);border-radius:16px;background:#fff"><span class="state-pill waiting">${state.lang === "hi" ? "इंतज़ार" : "Waiting"}</span><b style="display:block;margin-top:9px;font-size:13px">${state.lang === "hi" ? "ताज़ा नारियल" : "Fresh coconut"}</b><small style="display:block;margin-top:4px;color:var(--muted);font-size:9px">${state.lang === "hi" ? "आज माँगी · बुध के दोपहर के लिए" : "Asked today · for Wednesday lunch"}</small></article>
          <article style="padding:14px;border:1px solid var(--line);border-radius:16px;background:#fff"><span class="state-pill approved">${state.lang === "hi" ? "मंज़ूर" : "Approved"}</span><b style="display:block;margin-top:9px;font-size:13px">${state.lang === "hi" ? "हरी मिर्च" : "Green chillies"}</b><small style="display:block;margin-top:4px;color:var(--muted);font-size:9px">${state.lang === "hi" ? "कल माँगी" : "Asked yesterday"}</small></article>
        </div>
        ${gap(state.lang === "hi"
          ? "रसोईये की स्क्रीन पर कीमत, भुगतान, या चेकआउट का कोई रास्ता नहीं है — यही G1 की पुष्टि करता है। लेकिन स्पेक यह नहीं बताता कि दो रसोईयों में से कौन 'active Cook' है (G2) और टकराव की स्थिति कैसी दिखेगी।"
          : "There is no price, payment, or checkout path on the Cook screen — which confirms G1. But the spec doesn't define which of two Cooks is the 'active Cook' (G2) or how the two-Cook conflict state renders here.")}
      </div>
      ${cookBottomNav("groceries")}
    `,
  },

  /* ---- Groceries: pantry + cart + checkout ---- */
  {
    key: "groceries-cart", section: "Groceries", role: "Member",
    title: { en: "Suggested Cart + Estimated Pantry", hi: "किराना + पैंट्री" },
    acs: ["E1", "E2", "E3", "G1"],
    render: () => {
      const items = [
        { id: "coconut", emoji: "🥥", name: { en: "Fresh coconut", hi: "ताज़ा नारियल" }, pkg: "1 pc", pantry: "low", need: { en: "needed today", hi: "आज चाहिए" }, src: "request" },
        { id: "coriander", emoji: "🌿", name: { en: "Coriander", hi: "धनिया" }, pkg: "2 bunches", pantry: "low", need: { en: "needed today", hi: "आज चाहिए" } },
        { id: "oil", emoji: "🛢️", name: { en: "Cooking oil", hi: "खाने का तेल" }, pkg: "1 L", pantry: "unknown", need: { en: "needed tomorrow", hi: "कल चाहिए" } },
        { id: "rice", emoji: "🍚", name: { en: "Rice", hi: "चावल" }, pkg: "5 kg", pantry: "likely", need: { en: "needed day after", hi: "परसों चाहिए" } },
      ];
      return `
        ${memberHeader({ title: t("groceries") })}
        <div class="screen-scroll">
          <section class="grocery-summary">
            <span class="summary-icon">${icon("groceries", 28)}</span>
            <div><small>${state.lang === "hi" ? "अगले 3 दिनों के लिए" : "For the next 3 days"}</small><strong>${state.lang === "hi" ? "8 चीज़ें" : "8 grocery items"}</strong></div>
            <span class="summary-cost">${state.lang === "hi" ? "लगभग ₹640" : "about ₹640"}</span>
          </section>
          <div class="section-card">
            <div class="section-heading"><div><span class="eyebrow">${state.lang === "hi" ? "रसोईये से" : "From your Cook"}</span><h2>${state.lang === "hi" ? "1 माँग बाकी" : "1 request to review"}</h2></div><span class="count-badge">1</span></div>
            ${items.filter((i) => i.src === "request").map((i) => `
              <label class="cart-item"><input type="checkbox" ${state.cart[i.id] ? "checked" : ""} data-cart="${i.id}" />
                <span class="cart-qty"><b>${i.name[state.lang]}</b><small>${i.pkg}</small><span class="need-tag">${i.need[state.lang]}</span></span>
                <span class="pantry-tag ${i.pantry}">${state.lang === "hi" ? { likely: "शायद है", low: "कम हो सकता है", unknown: "पता नहीं" }[i.pantry] : { likely: "likely available", low: "may be low", unknown: "unknown" }[i.pantry]}</span>
              </label>`).join("")}
          </div>
          <div class="section-card">
            <div class="section-heading"><div><span class="eyebrow">${state.lang === "hi" ? "इस हफ़्ते के खाने से" : "From this week's meals"}</span><h2>${state.lang === "hi" ? "बाकी सुझाव" : "More suggestions"}</h2></div></div>
            ${items.filter((i) => !i.src).map((i) => `
              <label class="cart-item"><input type="checkbox" ${state.cart[i.id] ? "checked" : ""} data-cart="${i.id}" />
                <span class="cart-qty"><b>${i.name[state.lang]}</b><small>${i.pkg}</small><span class="need-tag">${i.need[state.lang]}</span></span>
                <span class="pantry-tag ${i.pantry}">${state.lang === "hi" ? { likely: "शायद है", low: "कम हो सकता है", unknown: "पता नहीं" }[i.pantry] : { likely: "likely available", low: "may be low", unknown: "unknown" }[i.pantry]}</span>
              </label>`).join("")}
          </div>
          ${gap(state.lang === "hi"
            ? "स्पेक में 'likely / may be low / unknown' के नियम तय हैं, लेकिन यह नहीं बताया गया कि उपयोगकर्ता इन्हें कैसे समझेगा या 'unknown' होने पर क्या करेगा। ताज़ा चीज़ों के कम होने का अनुमान (freshness window) कैसे दिखेगा — स्पेक में स्क्रीन-स्तर पर नहीं है।"
            : "The spec fixes the likely/may-be-low/unknown vocabulary, but not how a user interprets 'unknown' or what action it implies. Perishable freshness-window degradation has no screen-level representation defined.")}
          <button class="btn-primary" data-jump="checkout">${state.lang === "hi" ? "किराना देखें" : "Review cart"} ${icon("chevron", 18)}</button>
        </div>
        ${bottomNav("groceries")}
      `;
    },
  },
  {
    key: "checkout", section: "Groceries", role: "Member",
    title: { en: "Checkout — exact cart + fresh confirm", hi: "चेकआउट" },
    acs: ["I1", "I4"],
    render: () => {
      const step = state.checkout;
      return `
        ${memberHeader({ title: state.lang === "hi" ? "किराना देखें" : "Review cart", back: true })}
        <div class="screen-scroll">
          <div class="checkout-block">
            <div class="section-card">
              <div class="section-heading"><div><span class="eyebrow">${state.lang === "hi" ? "सटीक किराना — Swiggy Instamart" : "Exact cart — Swiggy Instamart"}</span><h2>${state.lang === "hi" ? "3 चीज़ें" : "3 items"}</h2></div></div>
              <div class="cart-item"><span class="pkg">🥥</span><span class="cart-qty"><b>${state.lang === "hi" ? "ताज़ा नारियल" : "Fresh coconut"}</b><small>${state.lang === "hi" ? "iD Fresh · 1 pc · ₹45" : "iD Fresh · 1 pc · ₹45"}</small></span><b>₹45</b></div>
              <div class="cart-item"><span class="pkg">🌿</span><span class="cart-qty"><b>${state.lang === "hi" ? "धनिया" : "Coriander"}</b><small>${state.lang === "hi" ? "2 गुच्छ · ₹30" : "2 bunches · ₹30"}</small></span><b>₹30</b></div>
              <div class="cart-item"><span class="pkg">🛢️</span><span class="cart-qty"><b>${state.lang === "hi" ? "खाने का तेल" : "Fortune cooking oil"}</b><small>${state.lang === "hi" ? "1 L · ₹165" : "1 L · ₹165"}</small></span><b>₹165</b></div>
            </div>
            <div class="total-row"><div><b>₹240</b><small>${state.lang === "hi" ? "₹1000 से कम — Cooklink में चेकआउट" : "Under ₹1000 — checkout in Cooklink"}</small></div><span>${icon("check", 22)}</span></div>
          </div>
          ${step === "review" ? `
            <button class="btn-primary" data-set="checkout" data-val="confirm">${state.lang === "hi" ? "चेकआउट पर जाएँ" : "Proceed to checkout"}</button>
          ` : step === "confirm" ? `
            <div class="confirm-sheet">
              <b>${state.lang === "hi" ? "पक्का करें: ₹240 का ऑर्डर" : "Confirm: ₹240 order"}</b>
              <small>${state.lang === "hi" ? "सर्वर हर बार आपकी भूमिका जाँचेगा। रसोईये चेकआउट नहीं कर सकते।" : "The server re-checks your role every time. Cooks cannot check out."}</small>
            </div>
            <button class="btn-primary" data-set="checkout" data-val="success">${state.lang === "hi" ? "ऑर्डर पक्का करें" : "Place order"}</button>
            <button class="btn-secondary" data-set="checkout" data-val="review">${state.lang === "hi" ? "वापस" : "Back"}</button>
          ` : `
            <div class="status-screen" style="flex:0;padding:16px 0">
              <div class="glyph">✅</div>
              <h2 style="font-size:20px">${state.lang === "hi" ? "ऑर्डर हो गया!" : "Order placed!"}</h2>
              <p>${state.lang === "hi" ? "इंस्टामार्ट 20 मिनट में लाएगा।" : "Instamart delivers in ~20 minutes."}</p>
            </div>
            <button class="btn-secondary" data-set="checkout" data-val="review">${state.lang === "hi" ? "हो गया" : "Done"}</button>
          `}
          ${gap(state.lang === "hi"
            ? "स्पेक कहता है 'exact cart review' ज़रूरी है, लेकिन substitution (जब Instamart किसी चीज़ की जगह दूसरी दे) का उपयोगकर्ता-स्तर पर नियम नहीं है। भुगतान विधि कौन सी दिखेगी — वह भी स्पेक में नहीं है।"
            : "The spec mandates 'exact cart review', but the substitution UX (when Instamart swaps an item) is undefined at the user level. Which payment method is shown and how the member picks one is also unspecified.")}
        </div>
      `;
    },
  },
  {
    key: "fallback", section: "Groceries", role: "Member",
    title: { en: "Fallback — ₹1000+ → Instamart app", hi: "फ़ॉलबैक" },
    acs: ["I3", "I4"],
    render: () => `
      ${memberHeader({ title: state.lang === "hi" ? "किराना देखें" : "Review cart", back: true })}
      <div class="screen-scroll">
        <div class="total-row" style="border-color:#e6b9ad"><div><b>₹1,180</b><small>${state.lang === "hi" ? "₹1000 से ज़्यादा" : "Above ₹1000"}</small></div><span style="color:var(--rust)">${icon("warning", 22)}</span></div>
        <div class="status-screen" style="flex:0;padding:10px 0">
          <div class="glyph">🛒</div>
          <h2 style="font-size:20px">${state.lang === "hi" ? "इंस्टामार्ट ऐप में जाएँ" : "Continue in the Instamart app"}</h2>
          <p>${state.lang === "hi" ? "बड़े ऑर्डर Cooklink के अंदर नहीं हो सकते। आपकी किराना वहाँ सिंक हो जाएगी।" : "Large orders can't complete inside Cooklink. Your cart syncs there."}</p>
        </div>
        <div class="fallback-card">
          <div class="brand"><span class="dot">I</span> Swiggy Instamart</div>
          <small>${state.lang === "hi" ? "किराना सिंक हो गई — ऐप खोलें और चेकआउट करें" : "Cart synced — open the app to check out"}</small>
        </div>
        <button class="btn-primary" style="background:var(--mango)">${icon("phone", 18)} ${state.lang === "hi" ? "इंस्टामार्ट ऐप खोलें" : "Open Instamart app"}</button>
        ${gap(state.lang === "hi"
          ? "स्पेक स्पष्ट कहता है कि deep link का वादा नहीं है — यह स्क्रीन उसी को दिखाती है। लेकिन 'synced cart' का मतलब (क्या वाक़ई सिंक होता है?) स्पेक में अनिर्धारित है।"
          : "The spec explicitly promises no deep link — this screen honors that. But what 'synced cart' actually means (does Instamart receive it?) is undefined in the spec.")}
      </div>
    `,
  },

  /* ---- Failures ---- */
  {
    key: "failure-checkout", section: "Failures", role: "Member",
    title: { en: "Failure — checkout retry via get_orders", hi: "विफलता — चेकआउट" },
    acs: ["I2", "FL1"],
    render: () => `
      ${memberHeader({ title: state.lang === "hi" ? "चेकआउट" : "Checkout", back: true })}
      <div class="screen-scroll">
        <div class="status-screen" style="flex:0;padding:10px 0">
          <div class="glyph">⚠️</div>
          <h2 style="font-size:20px">${state.lang === "hi" ? "नेटवर्क बीच में टूटा" : "Network dropped mid-checkout"}</h2>
          <p>${state.lang === "hi" ? "हम पहले जाँच करेंगे कि ऑर्डर हो गया या नहीं — बिना दोबारा ऑर्डर किए।" : "We check whether the order went through before retrying — no duplicate order."}</p>
        </div>
        <div class="confirm-sheet">
          <b>${state.lang === "hi" ? "idempotency key: ck_8f3a… जाँच रहे हैं" : "idempotency key: ck_8f3a… checking"}</b>
          <small>${state.lang === "hi" ? "get_orders से पुष्टि → फिर रीट्राय" : "verify via get_orders → then retry"}</small>
        </div>
        <button class="btn-primary" data-jump="checkout">${state.lang === "hi" ? "स्थिति जाँचें" : "Check status"}</button>
      </div>
    `,
  },
  {
    key: "failure-offline", section: "Failures", role: "Cook",
    title: { en: "Failure — offline outbox", hi: "ऑफ़लाइन आउटबॉक्स" },
    acs: ["FL1"],
    render: () => `
      ${cookChatHeader({ title: "Rao Family", sub: state.lang === "hi" ? "ऑफ़लाइन" : "Offline" })}
      <div class="screen-scroll inset">
        <p style="font-size:11px;color:var(--muted);margin:4px 0 12px">${state.lang === "hi" ? "संदेश तब तक दूसरों को नहीं दिखेंगे जब तक सर्वर स्वीकार न करे।" : "Messages aren't visible to others until the server accepts them."}</p>
        <div class="outbox-item"><span class="status-dot sent"></span><span><b>${state.lang === "hi" ? "सुप्रभात! 11 बजे शुरू…" : "Good morning! Starting at 11…"}</b><small>${state.lang === "hi" ? "भेज दिया" : "Sent"}</small></span><span></span></div>
        <div class="outbox-item"><span class="status-dot sending"></span><span><b>${state.lang === "hi" ? "नारियल चाहिए" : "Need coconut"}</b><small>${state.lang === "hi" ? "भेज रहे हैं…" : "Sending…"}</small></span><span></span></div>
        <div class="outbox-item failed"><span class="status-dot failed"></span><span><b>${state.lang === "hi" ? "फ़ोटो" : "Photo"}</b><small>${state.lang === "hi" ? "असफल — फिर कोशिश करें" : "Failed — retry"}</small></span><button class="retry">${state.lang === "hi" ? "फिर" : "Retry"}</button></div>
      </div>
      ${cookBottomNav("chat")}
    `,
  },
  {
    key: "failure-access", section: "Failures", role: "Cook",
    title: { en: "Failure — membership removed", hi: "पहुँच हटी" },
    acs: ["FL2"],
    render: () => `
      <div class="status-screen">
        <div class="glyph">🔒</div>
        <h2>${state.lang === "hi" ? "घर की पहुँच बदली" : "Household access changed"}</h2>
        <p>${state.lang === "hi" ? "Rao Family ने आपकी पहुँच हटा दी है। चैट और मीडिया तुरंत बंद।" : "Rao Family has removed your access. Chat and media are closed immediately."}</p>
        <button class="btn-primary" style="width:auto;padding:13px 28px" data-jump="cook-list">${state.lang === "hi" ? "अपने घर पर वापस" : "Back to my households"}</button>
      </div>
    `,
  },

  /* ---- Accessibility & language ---- */
  {
    key: "a11y-hindi", section: "Accessibility", role: "Member",
    title: { en: "Hindi locale + largest text scale", hi: "हिंदी + बड़ा टेक्स्ट" },
    acs: ["A1", "A2"],
    render: () => `
      ${memberHeader({ title: t("today") })}
      <div class="screen-scroll">
        <div class="date-line" style="display:flex;justify-content:space-between;margin:0 0 14px;padding:10px 13px;border-radius:12px;background:#edf4e4;color:#385544;font-size:12px"><b>मंगल, 25 जुलाई</b><span>3 वक़्त · 3 लोग</span></div>
        ${mealList()}
        ${gap(state.lang === "hi"
          ? "स्पेक में पहुँच (accessibility) सिर्फ़ 44pt टच टारगेट और सबसे बड़े टेक्स्ट स्केल तक सीमित है। VoiceOver/TalkBack, रंग-कंट्रास्ट, और कम-दृष्टि वाले उपयोगकर्ताओं के लिए कोई विस्तृत पहुँच-योजना नहीं है।"
          : "Accessibility in the spec is limited to 44pt touch targets and the largest text scale. There is no consolidated plan for VoiceOver/TalkBack, colour contrast, or low-vision users — a real gap for a low-literacy audience.")}
      </div>
      ${bottomNav("today")}
    `,
  },

  /* ---- Spec gap highlight ---- */
  {
    key: "dual-identity", section: "Spec gaps", role: "Member+Cook",
    title: { en: "Spec gap — dual identity (Member + Cook)", hi: "स्पेक गैप — दोहरी पहचान" },
    acs: [],
    render: () => `
      <div class="status-screen">
        <div class="glyph">🔀</div>
        <h2>${state.lang === "hi" ? "एक व्यक्ति — दो भूमिकाएँ" : "One person, two roles"}</h2>
        <p>${state.lang === "hi"
          ? "अगर कोई एक घर में सदस्य है और दूसरे में रसोईया — तो ऐप किस एंट्री शेल पर खुलेगा? यह सवाल issue 03 ने स्पष्ट रूप से 'implementation से पहले' के लिए टाला था।"
          : "If someone is a Member in one household and a Cook in another, which entry shell does the app open? Issue 03 explicitly deferred this to 'before implementation'."}</p>
      </div>
      <div style="padding:0 20px 28px">
        ${gap(state.lang === "hi"
          ? "यह V1 का एकमात्र स्पष्ट रूप से टाला गया फ़ैसला है। इसे implementation में जाने से पहले resolve करना ज़रूरी है, क्योंकि entry-shell चुनाव और नेविगेशन पूरे ऐप को प्रभावित करते हैं।"
          : "This is the only explicitly-deferred decision in V1. It must be resolved before implementation because the entry-shell choice and navigation shape the whole app.")}
        <button class="btn-primary" data-jump="firstuse-welcome">${state.lang === "hi" ? "शुरुआत पर वापस" : "Back to start"}</button>
      </div>
    `,
  },
];

/* ------------------------------------------------------------------ *
 * Top lab, journey bar, coverage overlay, state readout.
 * ------------------------------------------------------------------ */
function topLab() {
  return `
    <aside class="top-lab" aria-label="Prototype controls">
      <div class="group">
        <button class="${state.lang === "en" ? "active" : ""}" data-lang="en">EN</button>
        <button class="${state.lang === "hi" ? "active" : ""}" data-lang="hi">हिं</button>
      </div>
      <button class="coverage-btn ${state.coverage ? "on" : ""}" data-coverage aria-pressed="${state.coverage}">
        ${icon("check", 15)} ${state.lang === "hi" ? "मानदंड" : "Criteria"}
      </button>
    </aside>
  `;
}

function journeyBar() {
  const idx = STAGES.findIndex((s) => s.key === state.stage);
  const s = STAGES[idx];
  return `
    <aside class="journey-bar" aria-label="Journey">
      <button data-step="-1" aria-label="Previous stage">←</button>
      <div class="stage-info">
        <div class="stage-title">${s.title[state.lang]}</div>
        <div class="stage-meta"><b>${idx + 1}</b>/${STAGES.length} · ${s.section} · ${s.role}</div>
      </div>
      <button data-step="1" aria-label="Next stage">→</button>
    </aside>
  `;
}

function stateReadout() {
  const idx = STAGES.findIndex((s) => s.key === state.stage);
  const s = STAGES[idx];
  return `
    <div class="state-readout" aria-live="polite">
      PROTOTYPE · ${s.key} · ${state.lang.toUpperCase()} · ${s.acs.length ? s.acs.join(" ") : "no AC mapped (gap)"}
    </div>
  `;
}

function coverageOverlay() {
  if (!state.coverage) return "";
  const current = STAGES.find((s) => s.key === state.stage);
  const hit = new Set(current.acs);
  const groups = [];
  for (const id of Object.keys(ACCEPTANCE)) {
    const g = ACCEPTANCE[id].group;
    if (!groups.find((x) => x.name === g)) groups.push({ name: g, items: [] });
    groups.find((x) => x.name === g).items.push(id);
  }
  return `
    <div class="coverage-overlay" data-coverage-close>
      <div class="coverage-card">
        <div class="coverage-head">
          <h2>${state.lang === "hi" ? "V1 मानदंड कवरेज" : "V1 acceptance coverage"}</h2>
          <button data-coverage-close>${state.lang === "hi" ? "बंद करें" : "Close"}</button>
        </div>
        <div style="padding:6px 20px 20px">
          <p style="font-size:11px;color:var(--muted);margin:4px 0 14px">${state.lang === "hi"
            ? "हरा = इस स्टेज पर प्रदर्शित। बाकी सूची पूरे V1 के मापने योग्य मानदंड हैं।"
            : "Green = demonstrated by the current stage. The full list is the measurable V1 acceptance bar."}</p>
          ${groups
            .map(
              (g) => `
            <div class="coverage-group">
              <h3>${g.name}</h3>
              ${g.items
                .map(
                  (id) => `
                <div class="coverage-item ${hit.has(id) ? "hit" : "miss"}">
                  <span class="mark">${hit.has(id) ? "✓" : "○"}</span>
                  <span>${ACCEPTANCE[id].text}</span>
                  <span class="id">${id}</span>
                </div>`,
                )
                .join("")}
            </div>`,
            )
            .join("")}
        </div>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * Render + interactions.
 * ------------------------------------------------------------------ */
const app = document.querySelector("#app");

function render() {
  const stage = STAGES.find((s) => s.key === state.stage) || STAGES[0];
  app.innerHTML = `${topLab()}${phoneShell(stage.render())}${stateReadout()}${journeyBar()}${coverageOverlay()}`;
  wire();
}

function goStage(key) {
  if (!STAGES.find((s) => s.key === key)) return;
  state.stage = key;
  writeUrl();
  render();
}

function step(dir) {
  const idx = STAGES.findIndex((s) => s.key === state.stage);
  const next = STAGES[(idx + dir + STAGES.length) % STAGES.length];
  goStage(next.key);
}

function wire() {
  document.querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => step(Number(b.dataset.step))),
  );
  document.querySelectorAll("[data-lang]").forEach((b) =>
    b.addEventListener("click", () => {
      state.lang = b.dataset.lang;
      writeUrl();
      render();
    }),
  );
  document.querySelectorAll("[data-coverage]").forEach((b) =>
    b.addEventListener("click", () => {
      state.coverage = !state.coverage;
      writeUrl();
      render();
    }),
  );
  document.querySelectorAll("[data-coverage-close]").forEach((b) =>
    b.addEventListener("click", (e) => {
      if (e.target.hasAttribute("data-coverage-close") || e.target.closest("[data-coverage-close]")) {
        state.coverage = false;
        writeUrl();
        render();
      }
    }),
  );
  document.querySelectorAll("[data-jump]").forEach((b) =>
    b.addEventListener("click", () => goStage(b.dataset.jump)),
  );
  document.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", () => {
      const { toggle, val } = b.dataset;
      if (toggle === "style" || toggle === "diet" || toggle === "servings") state.onboard[toggle] = val;
      else state[toggle] = !state[toggle];
      render();
    }),
  );
  document.querySelectorAll("[data-set]").forEach((b) =>
    b.addEventListener("click", () => {
      state[b.dataset.set] = b.dataset.val;
      render();
    }),
  );
  document.querySelectorAll("[data-cart]").forEach((b) =>
    b.addEventListener("change", () => {
      state.cart[b.dataset.cart] = b.checked;
    }),
  );
  document.querySelectorAll("[data-advance]").forEach((b) =>
    b.addEventListener("click", () => step(1)),
  );

  // Chat composer: Send appends the typed message to the live chat log.
  document.querySelectorAll(".composer button.send").forEach((b) =>
    b.addEventListener("click", () => {
      const composer = b.closest(".composer");
      const input = composer?.querySelector("input");
      const text = (input?.value || "").trim();
      if (!text) return;
      const log = document.querySelector(".chat-log");
      if (log) {
        const msg = document.createElement("div");
        msg.className = "message outgoing";
        msg.textContent = text + " ";
        const small = document.createElement("small");
        small.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        msg.appendChild(small);
        log.appendChild(msg);
        log.scrollTop = log.scrollHeight;
      }
      if (input) input.value = "";
    }),
  );

  // Cook household search: filters the list as you type.
  document.querySelectorAll(".search-box input").forEach((inp) =>
    inp.addEventListener("input", () => {
      const q = inp.value.trim().toLowerCase();
      document.querySelectorAll(".household-row").forEach((row) => {
        const name = (row.querySelector("b")?.textContent || "").toLowerCase();
        row.style.display = !q || name.includes(q) ? "" : "none";
      });
    }),
  );
}

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable;
  if (typing) return;
  if (event.key === "ArrowRight") step(1);
  else if (event.key === "ArrowLeft") step(-1);
  else if (event.key.toLowerCase() === "l") {
    state.lang = state.lang === "en" ? "hi" : "en";
    writeUrl();
    render();
  } else if (event.key.toLowerCase() === "c") {
    state.coverage = !state.coverage;
    writeUrl();
    render();
  }
});

window.addEventListener("popstate", render);

readUrl();
render();
