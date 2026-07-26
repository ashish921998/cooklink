const variants = {
  A: { name: 'Three clear places', render: VariantA },
  B: { name: 'Chat with shortcuts', render: VariantB },
  C: { name: 'One household, three views', render: VariantC },
};

const households = [
  {
    id: 'rao',
    initials: 'AR',
    name: 'Rao Family',
    colour: 'mango',
    next: 'Lunch · Sambar rice',
    message: 'Less spicy today, please',
    time: '8:42',
    unread: 2,
  },
  {
    id: 'mehta',
    initials: 'SM',
    name: 'Mehta Home',
    colour: 'sage',
    next: 'Dinner · Palak paneer',
    message: 'Grocery request approved',
    time: 'Yesterday',
    unread: 0,
  },
  {
    id: 'iyer',
    initials: 'VI',
    name: 'Iyer Household',
    colour: 'blue',
    next: 'Lunch · Lemon rice',
    message: 'Photo',
    time: 'Yesterday',
    unread: 0,
  },
  {
    id: 'khan',
    initials: 'AK',
    name: 'Khan Family',
    colour: 'rose',
    next: 'Dinner · Chicken pulao',
    message: 'Voice message · 0:18',
    time: 'Mon',
    unread: 0,
  },
];

const state = {
  role: 'member',
  screen: 'today',
  householdId: null,
};

const app = document.querySelector('#app');

function currentVariant() {
  const key = new URLSearchParams(window.location.search).get('variant')?.toUpperCase();
  return variants[key] ? key : 'A';
}

function selectedHousehold() {
  return households.find((household) => household.id === state.householdId) ?? households[0];
}

function setRole(role) {
  state.role = role;
  state.screen = role === 'member' ? 'today' : 'households';
  state.householdId = null;
  render();
}

function navigate(screen) {
  state.screen = screen;
  render();
}

function openHousehold(id) {
  state.householdId = id;
  state.screen = 'chat';
  render();
}

function goToVariant(direction) {
  const keys = Object.keys(variants);
  const index = keys.indexOf(currentVariant());
  const nextKey = keys[(index + direction + keys.length) % keys.length];
  const url = new URL(window.location.href);
  url.searchParams.set('variant', nextKey);
  window.history.replaceState({}, '', url);
  state.screen = state.role === 'member' ? 'today' : 'households';
  state.householdId = null;
  render();
}

function icon(name, size = 22) {
  const paths = {
    back: '<path d="m15 18-6-6 6-6"/><path d="M9 12h10"/>',
    calendar:
      '<rect width="17" height="16" x="3.5" y="5" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    chat: '<path d="M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    groceries: '<path d="M6 8h12l1 13H5L6 8Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
    meal: '<path d="M6 3v8M3 3v5a3 3 0 0 0 6 0V3M6 11v10M16 3v18M16 3c3 2 4 5 4 8h-4"/>',
    mic: '<rect width="8" height="13" x="8" y="2" rx="4"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    plan: '<rect width="18" height="18" x="3" y="3" rx="3"/><path d="M8 2v3M16 2v3M3 9h18M8 13h3M8 17h7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    today: '<path d="M4 5h16v16H4zM8 3v4M16 3v4M4 10h16"/><path d="m9 15 2 2 4-4"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

function roleLab() {
  return `
    <aside class="role-lab" aria-label="Prototype role">
      <span class="lab-caption">View as</span>
      <div class="role-options">
        <button class="${state.role === 'member' ? 'active' : ''}" data-role="member" aria-pressed="${state.role === 'member'}">Member</button>
        <button class="${state.role === 'cook' ? 'active' : ''}" data-role="cook" aria-pressed="${state.role === 'cook'}">Cook</button>
      </div>
    </aside>
  `;
}

function switcher(key) {
  const visibleLocally =
    ['localhost', '127.0.0.1'].includes(window.location.hostname) ||
    window.location.protocol === 'file:';
  if (!visibleLocally) return '';
  return `
    <aside class="prototype-switcher" aria-label="Prototype variant switcher">
      <button data-cycle="-1" aria-label="Previous variant">←</button>
      <span><b>${key}</b> — ${variants[key].name}</span>
      <button data-cycle="1" aria-label="Next variant">→</button>
    </aside>
  `;
}

function stateReadout(key) {
  const household = state.householdId ? ` · ${selectedHousehold().name}` : '';
  return `
    <div class="state-readout" aria-live="polite">
      PROTOTYPE STATE · ${key} · ${state.role === 'member' ? 'Member' : 'Cook'} · ${labelForScreen(state.screen)}${household}
    </div>
  `;
}

function labelForScreen(screen) {
  return {
    households: 'Household list',
    today: 'Today’s Meals',
    plan: 'Meal Plan',
    groceries: 'Groceries',
    chat: 'Household Chat',
  }[screen];
}

function phoneShell(content, variantClass) {
  return `
    <main class="prototype-stage ${variantClass}">
      <div class="phone-frame">
        <div class="phone-status"><span>9:41</span><span class="status-glyphs">● ◒ ▰</span></div>
        <section class="phone-screen">${content}</section>
        <div class="home-indicator"></div>
      </div>
    </main>
  `;
}

function brandWordmark() {
  return `<span class="wordmark"><span class="brand-dot"></span>cooklink</span>`;
}

function avatar(household, large = false) {
  return `<span class="avatar ${household.colour} ${large ? 'large' : ''}">${household.initials}</span>`;
}

function memberHeader({ title, chatMode = 'icon', onBack = false }) {
  return `
    <header class="app-header">
      <div class="header-title">
        ${onBack ? `<button class="icon-button" data-nav="today" aria-label="Back">${icon('back')}</button>` : ''}
        <div>
          ${onBack ? '' : `<span class="eyebrow">Rao Family</span>`}
          <h1>${title}</h1>
        </div>
      </div>
      ${
        chatMode === 'icon'
          ? `<button class="icon-button has-dot" data-nav="chat" aria-label="Open Household Chat">${icon('chat')}</button>`
          : brandWordmark()
      }
    </header>
  `;
}

function todaysMeals({ compact = false, showRecipe = true } = {}) {
  const meals = [
    {
      time: 'Breakfast',
      meal: 'Vegetable poha',
      meta: '8:00 AM · 3 people',
      emoji: '🥣',
      tone: 'yellow',
    },
    { time: 'Lunch', meal: 'Sambar rice', meta: '1:00 PM · 3 people', emoji: '🍛', tone: 'orange' },
    {
      time: 'Dinner',
      meal: 'Palak paneer',
      meta: '8:00 PM · 4 people',
      emoji: '🥬',
      tone: 'green',
    },
  ];
  return `
    <div class="meal-list ${compact ? 'compact' : ''}">
      ${meals
        .map(
          (item, index) => `
            <article class="meal-row">
              <span class="meal-visual ${item.tone}">${item.emoji}</span>
              <div class="meal-copy">
                <span class="meal-time">${item.time}</span>
                <strong>${item.meal}</strong>
                <small>${item.meta}</small>
              </div>
              ${
                showRecipe && index === 1
                  ? `<button class="mini-action">Recipe ${icon('chevron', 16)}</button>`
                  : `<span class="row-chevron">${icon('chevron', 18)}</span>`
              }
            </article>
          `,
        )
        .join('')}
    </div>
  `;
}

function weekPlan() {
  const days = [
    ['Today', 'Poha', 'Sambar rice', 'Palak paneer'],
    ['Wed', 'Idli', 'Rajma rice', 'Aloo gobi'],
    ['Thu', 'Upma', 'Lemon rice', 'Dal tadka'],
    ['Fri', 'Dosa', 'Chole rice', 'Egg curry'],
  ];
  return `
    <div class="week-strip" aria-label="Days">
      <button class="selected"><b>Tue</b><small>25</small></button>
      <button><b>Wed</b><small>26</small></button>
      <button><b>Thu</b><small>27</small></button>
      <button><b>Fri</b><small>28</small></button>
      <button><b>Sat</b><small>29</small></button>
    </div>
    <div class="plan-days">
      ${days
        .map(
          (day, dayIndex) => `
          <article class="plan-day ${dayIndex === 0 ? 'active' : ''}">
            <div class="day-label"><b>${day[0]}</b>${dayIndex === 0 ? '<small>25 July</small>' : ''}</div>
            <div class="day-meals">
              <span><small>Breakfast</small>${day[1]}</span>
              <span><small>Lunch</small>${day[2]}</span>
              <span><small>Dinner</small>${day[3]}</span>
            </div>
          </article>
        `,
        )
        .join('')}
    </div>
  `;
}

function groceries() {
  return `
    <section class="grocery-summary">
      <span class="summary-icon">${icon('groceries', 28)}</span>
      <div><small>Needed for the next 3 days</small><strong>8 grocery items</strong></div>
      <span class="summary-cost">about ₹640</span>
    </section>
    <section class="request-card">
      <div class="section-heading"><div><span class="eyebrow">From your Cook</span><h2>2 requests to review</h2></div><span class="count-badge">2</span></div>
      <label class="grocery-item"><input type="checkbox" checked /><span><b>Fresh coconut</b><small>For Wednesday lunch</small></span><em>1</em></label>
      <label class="grocery-item"><input type="checkbox" checked /><span><b>Coriander</b><small>Running low</small></span><em>2 bunches</em></label>
    </section>
    <section class="pantry-note">
      ${icon('check', 20)}
      <span><b>6 more items suggested</b><small>Based on this week’s meals</small></span>
      ${icon('chevron', 18)}
    </section>
  `;
}

function householdList({ dense = false, heading = 'Households' } = {}) {
  return `
    <section class="household-list ${dense ? 'dense' : ''}">
      <header class="list-header">
        <div><span class="eyebrow">Tuesday, 25 July</span><h1>${heading}</h1></div>
        <button class="icon-button" aria-label="Household list options">${icon('more')}</button>
      </header>
      <label class="search-box">${icon('search', 19)}<input aria-label="Search households" placeholder="Search households" /></label>
      <div class="household-rows">
        ${households
          .map(
            (household) => `
            <button class="household-row" data-household="${household.id}">
              ${avatar(household)}
              <span class="household-copy">
                <span class="row-top"><b>${household.name}</b><small>${household.time}</small></span>
                <span class="next-meal">${household.next}</span>
                <span class="message-preview">${household.message}</span>
              </span>
              ${household.unread ? `<span class="unread">${household.unread}</span>` : ''}
            </button>
          `,
          )
          .join('')}
      </div>
    </section>
  `;
}

function chatBody({ shortcuts = false, pinned = false } = {}) {
  return `
    ${
      shortcuts
        ? `<div class="chat-shortcuts">
            <button data-nav="plan"><span>${icon('plan')}</span><b>Meal Plan</b><small>7 days</small></button>
            <button data-nav="groceries"><span>${icon('groceries')}</span><b>Groceries</b><small>2 requests</small></button>
          </div>`
        : ''
    }
    ${
      pinned
        ? `<button class="pinned-meal" data-nav="today"><span>🍛</span><span><small>Cooking now</small><b>Sambar rice · 3 people</b></span>${icon('chevron', 18)}</button>`
        : ''
    }
    <div class="chat-log">
      <div class="day-chip">Today</div>
      <div class="message incoming">Good morning! I am starting lunch at 11.<small>8:10</small></div>
      <div class="system-message">${icon('plan', 16)} Lunch changed to <b>Sambar rice</b></div>
      <div class="message outgoing">Perfect. Please make it less spicy today.<small>8:18 ✓✓</small></div>
      <div class="voice-message incoming"><button aria-label="Play voice message">${icon('mic', 18)}</button><span class="voice-line"></span><b>0:18</b><small>8:40</small></div>
      <div class="system-message grocery">${icon('groceries', 16)} New request: <b>Fresh coconut</b></div>
    </div>
    <form class="composer">
      <button type="button" aria-label="Record voice note">${icon('mic')}</button>
      <input aria-label="Message" placeholder="Message" />
      <button type="button" class="send" aria-label="Send">${icon('send', 19)}</button>
    </form>
  `;
}

function householdChatHeader({ segmented = false }) {
  const household = selectedHousehold();
  return `
    <header class="chat-header">
      <button class="icon-button" data-nav="${state.role === 'cook' ? 'households' : 'today'}" aria-label="Back">${icon('back')}</button>
      ${avatar(household)}
      <div><h1>${household.name}</h1><small>${state.role === 'cook' ? '3 Members' : 'Cook online'}</small></div>
      <button class="icon-button trailing" aria-label="Household options">${icon('more')}</button>
    </header>
    ${
      segmented
        ? `<nav class="segmented-nav" aria-label="Household views">
            ${segmentButton('chat', 'Chat', 'chat')}
            ${segmentButton('plan', 'Meal Plan', 'plan')}
            ${segmentButton('groceries', 'Groceries', 'groceries', true)}
          </nav>`
        : ''
    }
  `;
}

function bottomNav(items) {
  return `
    <nav class="bottom-nav" aria-label="Primary navigation">
      ${items
        .map(
          ([screen, label, iconName, count]) => `
          <button class="${state.screen === screen ? 'active' : ''}" data-nav="${screen}" ${state.screen === screen ? 'aria-current="page"' : ''}>
            <span class="nav-icon">${icon(iconName)}${count ? `<i>${count}</i>` : ''}</span>
            <span>${label}</span>
          </button>
        `,
        )
        .join('')}
    </nav>
  `;
}

function segmentButton(screen, label, iconName, count = false) {
  return `
    <button class="${state.screen === screen ? 'active' : ''}" data-nav="${screen}" ${state.screen === screen ? 'aria-current="page"' : ''}>
      ${icon(iconName, 19)}<span>${label}</span>${count ? '<i>2</i>' : ''}
    </button>
  `;
}

function memberDestination(screen, options = {}) {
  if (screen === 'chat') {
    if (!state.householdId) state.householdId = 'rao';
    return `${householdChatHeader({ segmented: options.segmented })}${chatBody({ shortcuts: options.shortcuts, pinned: options.pinned })}`;
  }
  if (screen === 'plan') {
    return `${memberHeader({ title: 'Meal Plan', onBack: options.contextual })}<div class="screen-scroll">${weekPlan()}</div>`;
  }
  if (screen === 'groceries') {
    return `${memberHeader({ title: 'Groceries', onBack: options.contextual })}<div class="screen-scroll">${groceries()}</div>`;
  }
  return `
    ${memberHeader({ title: options.title ?? 'Today’s Meals' })}
    <div class="date-line"><b>Tuesday, 25 July</b><span>3 meals · 3 people</span></div>
    <div class="screen-scroll">${todaysMeals()}</div>
  `;
}

function cookDestination(options = {}) {
  if (state.screen === 'households')
    return householdList({ dense: options.dense, heading: options.heading });
  if (state.screen === 'plan') {
    return `${householdChatHeader({ segmented: options.segmented })}<div class="screen-scroll inset">${weekPlan()}</div>`;
  }
  if (state.screen === 'groceries') {
    return `${householdChatHeader({ segmented: options.segmented })}<div class="screen-scroll inset">${cookGroceryRequests()}</div>`;
  }
  if (state.screen === 'today') {
    return `${householdChatHeader({ segmented: options.segmented })}<div class="screen-scroll inset"><div class="cook-today-title"><span class="eyebrow">Tuesday, 25 July</span><h2>Today’s cooking</h2></div>${todaysMeals({ compact: true })}</div>`;
  }
  return `${householdChatHeader({ segmented: options.segmented })}${chatBody({ shortcuts: options.shortcuts, pinned: options.pinned })}`;
}

function cookGroceryRequests() {
  return `
    <div class="cook-today-title"><span class="eyebrow">Rao Family</span><h2>Groceries</h2></div>
    <button class="new-request">${icon('mic', 23)}<span><b>Ask for a grocery</b><small>Speak or type what is missing</small></span>${icon('chevron', 18)}</button>
    <div class="request-list">
      <article><span class="request-state waiting">Waiting</span><b>Fresh coconut</b><small>Asked today · For Wednesday lunch</small></article>
      <article><span class="request-state approved">Approved</span><b>Green chillies</b><small>Asked yesterday</small></article>
    </div>
  `;
}

export function VariantA() {
  if (state.role === 'member') {
    const body = memberDestination(state.screen);
    return phoneShell(
      `${body}${
        state.screen !== 'chat'
          ? bottomNav([
              ['today', 'Today', 'today'],
              ['plan', 'Meal Plan', 'plan'],
              ['groceries', 'Groceries', 'groceries', 2],
            ])
          : ''
      }`,
      'variant-a',
    );
  }

  const inHousehold = state.screen !== 'households';
  return phoneShell(
    `${cookDestination({ pinned: true })}${
      inHousehold
        ? bottomNav([
            ['chat', 'Chat', 'chat'],
            ['plan', 'Meal Plan', 'plan'],
            ['groceries', 'Groceries', 'groceries', 2],
          ])
        : ''
    }`,
    'variant-a',
  );
}

export function VariantB() {
  if (state.role === 'member') {
    const body =
      state.screen === 'today'
        ? `
          ${memberHeader({ title: 'Good morning', chatMode: 'wordmark' })}
          <div class="hero-today"><span>Today · 25 July</span><h2>What are we eating?</h2></div>
          <div class="screen-scroll contextual-scroll">
            ${todaysMeals({ showRecipe: false })}
            <div class="big-shortcuts">
              <button data-nav="plan">${icon('plan', 25)}<span><b>Meal Plan</b><small>See all 7 days</small></span>${icon('chevron', 18)}</button>
              <button data-nav="groceries">${icon('groceries', 25)}<span><b>Groceries</b><small>2 requests waiting</small></span><i>2</i>${icon('chevron', 18)}</button>
            </div>
          </div>
          <button class="chat-fab" data-nav="chat" aria-label="Open Household Chat">${icon('chat', 24)}<span>Chat</span><i>2</i></button>
        `
        : memberDestination(state.screen, { contextual: true, shortcuts: true, pinned: true });
    return phoneShell(body, 'variant-b');
  }

  return phoneShell(
    cookDestination({
      dense: true,
      heading: 'Your families',
      shortcuts: state.screen === 'chat',
      pinned: state.screen === 'chat',
    }),
    'variant-b',
  );
}

export function VariantC() {
  if (state.role === 'member') {
    if (state.screen === 'today') {
      return phoneShell(
        `
          ${memberHeader({ title: 'Today' })}
          <nav class="member-top-nav" aria-label="Household views">
            ${segmentButton('today', 'Today', 'today')}
            ${segmentButton('plan', 'Meal Plan', 'plan')}
            ${segmentButton('groceries', 'Groceries', 'groceries', true)}
          </nav>
          <div class="screen-scroll top-nav-scroll">
            <div class="editorial-intro"><span>Tuesday, 25 July</span><h2>Three meals,<br />all planned.</h2></div>
            ${todaysMeals()}
          </div>
        `,
        'variant-c',
      );
    }
    if (state.screen === 'chat') {
      return phoneShell(
        `${householdChatHeader({ segmented: true })}${chatBody({ pinned: true })}`,
        'variant-c',
      );
    }
    const body =
      state.screen === 'plan'
        ? `${memberHeader({ title: 'Meal Plan' })}${memberTopNav()}<div class="screen-scroll top-nav-scroll">${weekPlan()}</div>`
        : `${memberHeader({ title: 'Groceries' })}${memberTopNav()}<div class="screen-scroll top-nav-scroll">${groceries()}</div>`;
    return phoneShell(body, 'variant-c');
  }

  const screen =
    state.screen === 'households'
      ? householdList({ heading: 'Households' })
      : cookDestination({ segmented: true, pinned: true });
  return phoneShell(screen, 'variant-c');
}

function memberTopNav() {
  return `
    <nav class="member-top-nav" aria-label="Household views">
      ${segmentButton('today', 'Today', 'today')}
      ${segmentButton('plan', 'Meal Plan', 'plan')}
      ${segmentButton('groceries', 'Groceries', 'groceries', true)}
    </nav>
  `;
}

function wireInteractions() {
  document.querySelectorAll('[data-role]').forEach((button) => {
    button.addEventListener('click', () => setRole(button.dataset.role));
  });
  document.querySelectorAll('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.nav));
  });
  document.querySelectorAll('[data-household]').forEach((button) => {
    button.addEventListener('click', () => openHousehold(button.dataset.household));
  });
  document.querySelectorAll('[data-cycle]').forEach((button) => {
    button.addEventListener('click', () => goToVariant(Number(button.dataset.cycle)));
  });
}

function render() {
  const key = currentVariant();
  app.innerHTML = `${roleLab()}${variants[key].render()}${stateReadout(key)}${switcher(key)}`;
  wireInteractions();
}

window.addEventListener('popstate', render);
window.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable
  ) {
    return;
  }
  goToVariant(event.key === 'ArrowRight' ? 1 : -1);
});

render();
