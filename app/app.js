// Upheld app: sign-in, groups and invites, prayer lists, prayer time, requests and approvals.
// Plain JavaScript, no build step. All access control is enforced by Supabase Row Level Security;
// this file only decides what to show.
(function () {
  'use strict';

  var cfg = window.UPHELD_CONFIG;
  if (!window.supabase || !cfg) {
    // The Supabase library comes from a CDN; without it nothing works, so say so plainly.
    var box = document.getElementById('app');
    var msg = document.createElement('main');
    msg.className = 'screen';
    var h1 = document.createElement('h1');
    h1.textContent = 'Can\'t load Upheld';
    var p = document.createElement('p');
    p.className = 'lede';
    p.textContent = 'Check your internet connection, then try again.';
    var retry = document.createElement('button');
    retry.className = 'btn';
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.addEventListener('click', function () { location.reload(); });
    msg.append(h1, p, retry);
    box.replaceChildren(msg);
    return;
  }
  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'upheld-auth' }
  });

  var $app = document.getElementById('app');
  var $toast = document.getElementById('toast');
  var store = makeStore();

  var state = {
    user: null,
    profile: null,
    groups: [],
    groupId: store.get('groupId'),
    tab: 'prayers',
    email: store.get('email') || '',
    pendingCount: 0,
    pendingPrayers: 0
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  // localStorage can throw (private mode); treat it as a convenience only.
  function makeStore() {
    return {
      get: function (k) { try { return localStorage.getItem('upheld.' + k); } catch (e) { return null; } },
      set: function (k, v) { try { v == null ? localStorage.removeItem('upheld.' + k) : localStorage.setItem('upheld.' + k, v); } catch (e) {} }
    };
  }

  // Build DOM nodes without innerHTML, so names and other user text are never parsed as HTML.
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  function svg(path) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('width', '20');
    s.setAttribute('height', '20');
    path.split('|').forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }
  var ICONS = {
    prayers: 'M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2|M4 19.5A2.5 2.5 0 0 1 6.5 17H20',
    people: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8|M23 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75',
    group: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6|M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-2.82-1.17l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3 15.4H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 10 4.6V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.17l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.6 10H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    chevron: 'M6 9l6 6 6-6'
  };

  function render(node) {
    closeSheet();
    state.view = 'other';
    $app.replaceChildren(node);
    var focusTarget = $app.querySelector('[data-autofocus]') || $app.querySelector('h1, h2');
    if (focusTarget) {
      if (!focusTarget.hasAttribute('data-autofocus')) focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }

  var toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, 3200);
  }

  function friendlyError(err) {
    var m = (err && (err.message || err.error_description)) || String(err || '');
    if (/rate limit|too many|over_email_send_rate/i.test(m)) return 'Too many tries. Please wait a few minutes and try again.';
    if (/expired|invalid.*(otp|token)|otp.*(invalid|expired)|token has expired/i.test(m)) return 'That code didn\'t work. Check it, or send a new one.';
    if (/invalid invite code/i.test(m)) return 'That invite code wasn\'t found. Check it with the person who sent it.';
    if (/fetch|network|load failed/i.test(m)) return 'Can\'t reach Upheld. Check your connection and try again.';
    return m || 'Something went wrong. Please try again.';
  }

  // Run an async action from a button: disable it, show errors in `errEl`.
  function busy(button, errEl, fn) {
    return function (ev) {
      if (ev) ev.preventDefault();
      if (button.disabled) return;
      var label = button.textContent;
      button.disabled = true;
      if (errEl) errEl.textContent = '';
      Promise.resolve()
        .then(fn)
        .catch(function (err) {
          if (errEl) errEl.textContent = friendlyError(err);
          else toast(friendlyError(err));
        })
        .then(function () {
          // Put the label back only if the action showed a temporary "…" label; actions may set a new one.
          if (button.isConnected) {
            button.disabled = false;
            if (/…$/.test(button.textContent)) button.textContent = label;
          }
        });
    };
  }

  // Supabase returns { data, error }; turn errors into exceptions.
  function must(res) {
    if (res.error) throw res.error;
    return res.data;
  }
  // For updates/deletes: RLS silently skips rows you may not change, so require at least one row back.
  function mustChange(res) {
    var rows = must(res);
    if (!rows || !rows.length) throw new Error('You don\'t have permission to do that.');
    return rows;
  }

  function brand() {
    return h('div', { class: 'brand' },
      h('img', { src: '../icons/icon-192.png', alt: '' }),
      h('span', { text: 'Upheld' }));
  }

  function currentGroup() {
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].group_id === state.groupId) return state.groups[i];
    }
    return null;
  }
  function isApprover(g) { return g && g.status === 'active' && (g.role === 'owner' || g.role === 'approver'); }
  function isOwner(g) { return g && g.status === 'active' && g.role === 'owner'; }

  // ---------------------------------------------------------------------------
  // Sign-in: email, then a 6-digit code typed into the app
  // ---------------------------------------------------------------------------

  function showEmail(message) {
    var err = h('p', { class: 'error', role: 'alert' });
    var input = h('input', {
      type: 'email', id: 'email', name: 'email', autocomplete: 'email', inputmode: 'email',
      autocapitalize: 'off', spellcheck: 'false', required: true, value: state.email, 'data-autofocus': true
    });
    var button = h('button', { class: 'btn block', type: 'submit', text: 'Send my code' });
    var form = h('form', { class: 'card', novalidate: true },
      h('div', { class: 'field' },
        h('label', { for: 'email', text: 'Email' }),
        input),
      button,
      err);
    form.addEventListener('submit', busy(button, err, function () {
      var email = input.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
      button.textContent = 'Sending…';
      return sb.auth.signInWithOtp({
        email: email,
        options: { shouldCreateUser: true, emailRedirectTo: location.origin + '/app/' }
      }).then(must).then(function () {
        state.email = email;
        store.set('email', email);
        showCode();
      });
    }));

    render(h('main', { class: 'screen' },
      brand(),
      h('h1', { text: 'Sign in' }),
      h('p', { class: 'lede', text: 'Enter your email and we\'ll send you a sign-in code. No password needed.' }),
      message ? h('div', { class: 'notice' }, h('p', { text: message })) : null,
      form));
  }

  function showCode() {
    var err = h('p', { class: 'error', role: 'alert' });
    var input = h('input', {
      type: 'text', id: 'code', name: 'code', class: 'code', inputmode: 'numeric', autocomplete: 'one-time-code',
      pattern: '[0-9]*', maxlength: '10', required: true, 'data-autofocus': true, 'aria-describedby': 'code-hint'
    });
    var button = h('button', { class: 'btn block', type: 'submit', text: 'Sign in' });
    var form = h('form', { class: 'card', novalidate: true },
      h('div', { class: 'field' },
        h('label', { for: 'code', text: 'Sign-in code' }),
        input,
        h('span', { class: 'hint', id: 'code-hint', text: 'Check your email for a code from Upheld. It may take a minute to arrive.' })),
      button,
      err);

    function submit() {
      var token = input.value.replace(/\D/g, '');
      if (token.length < 6) throw new Error('Enter the code from your email.');
      button.textContent = 'Checking…';
      return sb.auth.verifyOtp({ email: state.email, token: token, type: 'email' })
        .then(must)
        .then(function (data) { return afterSignIn(data.user); });
    }
    form.addEventListener('submit', busy(button, err, submit));
    input.addEventListener('input', function () {
      var digits = input.value.replace(/\D/g, '');
      if (digits !== input.value) input.value = digits;
    });

    var resend = h('button', { class: 'btn quiet', type: 'button', text: 'Send a new code' });
    resend.addEventListener('click', busy(resend, err, function () {
      return sb.auth.signInWithOtp({ email: state.email, options: { shouldCreateUser: true } })
        .then(must)
        .then(function () { toast('New code sent.'); });
    }));

    render(h('main', { class: 'screen' },
      brand(),
      h('h1', { text: 'Enter your code' }),
      h('p', { class: 'lede' }, 'We sent a code to ', h('strong', { text: state.email }), '.'),
      form,
      h('div', { class: 'row' },
        resend,
        h('button', { class: 'btn quiet', type: 'button', text: 'Use a different email', onclick: function () { showEmail(); } }))));
  }

  // ---------------------------------------------------------------------------
  // After sign-in: profile name, then groups
  // ---------------------------------------------------------------------------

  function afterSignIn(user) {
    state.user = user;
    return sb.from('profiles').select('id, display_name').eq('id', user.id).maybeSingle()
      .then(must)
      .then(function (profile) {
        state.profile = profile;
        if (!profile || !profile.display_name) return showName(true);
        return loadGroups().then(route).then(handleDeepLink);
      });
  }

  function showName(firstTime) {
    var err = h('p', { class: 'error', role: 'alert' });
    var input = h('input', {
      type: 'text', id: 'name', name: 'name', autocomplete: 'name', maxlength: '80', required: true,
      value: (state.profile && state.profile.display_name) || '', 'data-autofocus': true
    });
    var button = h('button', { class: 'btn block', type: 'submit', text: firstTime ? 'Continue' : 'Save' });
    var form = h('form', { class: 'card', novalidate: true },
      h('div', { class: 'field' },
        h('label', { for: 'name', text: 'Your name' },
          h('span', { class: 'hint', text: 'This is how your group will see you. First name and last initial is fine.' })),
        input),
      button,
      err);
    form.addEventListener('submit', busy(button, err, function () {
      var name = input.value.trim().replace(/\s+/g, ' ');
      if (!name) throw new Error('Enter your name.');
      return sb.from('profiles').upsert({ id: state.user.id, display_name: name }).select().then(mustChange)
        .then(function (rows) {
          state.profile = rows[0];
          if (firstTime) return loadGroups().then(route);
          toast('Name saved.');
          route();
        });
    }));

    render(h('main', { class: 'screen' },
      brand(),
      h('h1', { text: firstTime ? 'Welcome' : 'Your name' }),
      firstTime ? h('p', { class: 'lede', text: 'One quick thing before you join a group.' }) : null,
      form,
      firstTime ? null : h('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: function () { route(); } })));
  }

  function loadGroups() {
    return sb.rpc('my_groups').then(must).then(function (rows) {
      state.groups = rows || [];
      if (!currentGroup()) {
        var active = state.groups.filter(function (g) { return g.status === 'active'; });
        state.groupId = (active[0] || state.groups[0] || {}).group_id || null;
      }
      store.set('groupId', state.groupId);
    });
  }

  function selectGroup(id) {
    state.groupId = id;
    state.tab = 'prayers';
    state.pendingCount = 0;
    state.pendingPrayers = 0;
    store.set('groupId', id);
    route();
  }

  function route() {
    var g = currentGroup();
    if (!g) return showStart();
    if (g.status === 'pending') return showPending(g);
    return showGroup(g);
  }

  // ---------------------------------------------------------------------------
  // Create or join a group
  // ---------------------------------------------------------------------------

  function showStart() {
    var joinErr = h('p', { class: 'error', role: 'alert' });
    var codeInput = h('input', {
      type: 'text', id: 'invite', name: 'invite', class: 'code', autocomplete: 'off', autocapitalize: 'characters',
      spellcheck: 'false', maxlength: '12', required: true
    });
    var joinBtn = h('button', { class: 'btn block', type: 'submit', text: 'Ask to join' });
    var joinForm = h('form', { class: 'card', novalidate: true },
      h('h2', { text: 'Join a group' }),
      h('div', { class: 'field' },
        h('label', { for: 'invite', text: 'Invite code' },
          h('span', { class: 'hint', text: 'Ask your group\'s leader for the code. An approver will let you in.' })),
        codeInput),
      joinBtn,
      joinErr);
    joinForm.addEventListener('submit', busy(joinBtn, joinErr, function () {
      var code = codeInput.value.replace(/[\s-]/g, '').toUpperCase();
      if (code.length < 6) throw new Error('Enter the invite code.');
      joinBtn.textContent = 'Sending request…';
      return sb.rpc('join_group', { p_invite_code: code }).then(must).then(function (rows) {
        var joined = rows && rows[0];
        state.groupId = joined.group_id;
        return loadGroups().then(function () {
          if (joined.status === 'active') toast('You\'re already in ' + joined.group_name + '.');
          selectGroup(joined.group_id);
        });
      });
    }));

    var createErr = h('p', { class: 'error', role: 'alert' });
    var nameInput = h('input', { type: 'text', id: 'group-name', name: 'group-name', maxlength: '80', required: true });
    var createBtn = h('button', { class: 'btn block secondary', type: 'submit', text: 'Create group' });
    var createForm = h('form', { class: 'card', novalidate: true },
      h('h2', { text: 'Start a new group' }),
      h('div', { class: 'field' },
        h('label', { for: 'group-name', text: 'Group name' },
          h('span', { class: 'hint', text: 'You\'ll be the owner. You can invite people and choose approvers.' })),
        nameInput),
      createBtn,
      createErr);
    createForm.addEventListener('submit', busy(createBtn, createErr, function () {
      var name = nameInput.value.trim().replace(/\s+/g, ' ');
      if (!name) throw new Error('Enter a name for your group.');
      createBtn.textContent = 'Creating…';
      return sb.rpc('create_group', { p_name: name, p_description: null }).then(must).then(function (g) {
        var id = (Array.isArray(g) ? g[0] : g).id;
        state.groupId = id;
        return loadGroups().then(function () {
          state.tab = 'group';
          store.set('groupId', id);
          toast('Group created. Share the invite code to add people.');
          route();
        });
      });
    }));

    var hasGroups = state.groups.length > 0;
    render(h('main', { class: 'screen' },
      brand(),
      h('h1', { text: hasGroups ? 'Add a group' : 'Find your group' }),
      h('p', { class: 'lede' }, 'Signed in as ', h('strong', { text: (state.profile && state.profile.display_name) || '' }), '.'),
      joinForm,
      h('p', { class: 'divider', text: 'or' }),
      createForm,
      h('div', { class: 'row' },
        hasGroups ? h('button', { class: 'btn quiet', type: 'button', text: 'Back to my groups', onclick: function () { route(); } }) : null,
        h('button', { class: 'btn quiet', type: 'button', text: 'Sign out', onclick: signOut }))));
  }

  function showPending(g) {
    var err = h('p', { class: 'error', role: 'alert' });
    var check = h('button', { class: 'btn block', type: 'button', text: 'Check again' });
    check.addEventListener('click', busy(check, err, function () {
      return loadGroups().then(function () {
        var now = currentGroup();
        if (now && now.status === 'active') toast('You\'re in! Welcome to ' + now.name + '.');
        else toast('Still waiting for approval.');
        route();
      });
    }));
    var cancel = h('button', { class: 'btn danger block', type: 'button', text: 'Cancel my request' });
    cancel.addEventListener('click', busy(cancel, err, function () {
      if (!confirm('Cancel your request to join ' + g.name + '?')) return;
      return sb.from('group_members').delete().eq('group_id', g.group_id).eq('user_id', state.user.id).select()
        .then(mustChange)
        .then(function () { state.groupId = null; return loadGroups(); })
        .then(route);
    }));

    render(h('main', { class: 'screen' },
      brand(),
      h('h1', { text: 'Waiting for approval' }),
      h('p', { class: 'lede' }, 'You asked to join ', h('strong', { text: g.name }), '. An approver will let you in soon. Once they do, the group\'s prayers will show up here.'),
      h('div', { class: 'card stack' }, check, cancel, err),
      h('div', { class: 'row' },
        state.groups.length > 1 ? h('button', { class: 'btn quiet', type: 'button', text: 'Switch group', onclick: openGroupSheet }) : null,
        h('button', { class: 'btn quiet', type: 'button', text: 'Join a different group', onclick: showStart }),
        h('button', { class: 'btn quiet', type: 'button', text: 'Sign out', onclick: signOut }))));
    state.view = 'pending';
  }

  // ---------------------------------------------------------------------------
  // Inside a group: top bar, tabs, and three screens
  // ---------------------------------------------------------------------------

  function showGroup(g) {
    var content = h('main', { class: 'content', id: 'content' });
    var tabs = [
      { id: 'prayers', label: 'Prayers', badge: isApprover(g) ? state.pendingPrayers : 0 },
      { id: 'people', label: 'People', badge: isApprover(g) ? state.pendingCount : 0 },
      { id: 'group', label: 'Group' }
    ];
    var tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Sections' },
      h('div', { class: 'tabbar-inner' }, tabs.map(function (t) {
        return h('button', {
          class: 'tab', type: 'button', 'aria-current': state.tab === t.id ? 'page' : null,
          onclick: function () { state.tab = t.id; showGroup(g); }
        },
        svg(ICONS[t.id]),
        t.label,
        t.badge ? h('span', { class: 'badge', text: String(t.badge), 'aria-label': t.badge + ' waiting' }) : null);
      })));

    var topbar = h('header', { class: 'topbar' },
      h('div', { class: 'topbar-inner' },
        h('img', { src: '../icons/icon-192.png', alt: '' }),
        h('button', { class: 'group-switch', type: 'button', 'aria-label': 'Switch group. Current group: ' + g.name, onclick: openGroupSheet },
          h('span', { text: g.name }), svg(ICONS.chevron))));

    render(h('div', { style: 'display:contents' }, topbar, content, tabbar));
    state.view = 'group';

    if (state.tab === 'people') renderPeople(g, content);
    else if (state.tab === 'group') renderGroupSettings(g, content);
    else renderPrayers(g, content);

    if (isApprover(g)) refreshPendingCount(g);
  }

  // Approvers: keep the "waiting" badges on the Prayers and People tabs current.
  function refreshPendingCount(g) {
    sb.rpc('group_roster', { p_group_id: g.group_id }).then(must).then(function (rows) {
      state.pendingCount = rows.filter(function (r) { return r.status === 'pending'; }).length;
      setBadge(g, 1, state.pendingCount);
    }).catch(function () {});
    sb.from('prayers').select('id', { count: 'exact', head: true })
      .eq('group_id', g.group_id).eq('status', 'pending')
      .then(function (res) {
        if (res.error) return;
        state.pendingPrayers = res.count || 0;
        setBadge(g, 0, state.pendingPrayers);
      });
  }

  function setBadge(g, index, n) {
    if (currentGroup() !== g || state.view !== 'group') return;
    var tab = $app.querySelectorAll('.tab')[index];
    if (!tab) return;
    var old = tab.querySelector('.badge');
    if (old) old.remove();
    if (n) tab.appendChild(h('span', { class: 'badge', text: String(n), 'aria-label': n + ' waiting' }));
  }

  // ---------------------------------------------------------------------------
  // Prayers tab: list tabs (All, each list, Praise), prayer detail, "I prayed"
  // ---------------------------------------------------------------------------

  // Cache of the current group's lists, prayers, and totals, refreshed each time the tab opens.
  var pdata = { groupId: null, lists: [], prayers: [], totals: {} };
  var listTab = store.get('listTab') || 'all';

  function loadPrayerData(g) {
    return Promise.all([
      sb.from('lists').select('id, name, sort_order').eq('group_id', g.group_id)
        .order('sort_order', { ascending: true }).order('name', { ascending: true }).then(must),
      sb.from('prayers').select('id, list_id, title, body, status, created_at, answered_at, requested_by, requester_name, urgent, pray_at')
        .eq('group_id', g.group_id).in('status', ['pending', 'active', 'answered'])
        .order('created_at', { ascending: true }).then(must),
      sb.rpc('prayed_totals', { p_group_id: g.group_id }).then(must)
    ]).then(function (r) {
      var totals = {};
      (r[2] || []).forEach(function (t) { totals[t.prayer_id] = { total: Number(t.total), mine: Number(t.mine) }; });
      pdata = { groupId: g.group_id, lists: r[0] || [], prayers: r[1] || [], totals: totals };
      return pdata;
    });
  }

  function listName(id) {
    for (var i = 0; i < pdata.lists.length; i++) if (pdata.lists[i].id === id) return pdata.lists[i].name;
    return '';
  }
  function totalFor(id) { return (pdata.totals[id] && pdata.totals[id].total) || 0; }
  function prayedLabel(n) { return n ? 'Prayed ' + n + 'x' : 'Not prayed yet'; }

  function renderPrayers(g, el) {
    el.replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));
    Promise.all([loadPrayerData(g), isApprover(g) ? loadRosterNames(g) : null]).then(function () {
      if (currentGroup() !== g || state.tab !== 'prayers') return;
      drawPrayers(g, el);
    }).catch(function (err) {
      el.replaceChildren(h('p', { class: 'error', text: friendlyError(err) }),
        h('button', { class: 'btn secondary', type: 'button', text: 'Try again', onclick: function () { renderPrayers(g, el); } }));
    });
  }

  function drawPrayers(g, el) {
    var tabs = [{ id: 'all', name: 'All' }]
      .concat(pdata.lists.map(function (l) { return { id: l.id, name: l.name }; }))
      .concat([{ id: 'praise', name: 'Praise' }]);
    if (!tabs.some(function (t) { return t.id === listTab; })) listTab = 'all';

    var active = pdata.prayers.filter(function (p) { return p.status === 'active'; });
    var shown;
    if (listTab === 'praise') {
      shown = pdata.prayers.filter(function (p) { return p.status === 'answered'; })
        .sort(function (a, b) { return String(b.answered_at || '').localeCompare(String(a.answered_at || '')); });
    } else if (listTab === 'all') {
      shown = urgentFirst(active);
    } else {
      shown = urgentFirst(active.filter(function (p) { return p.list_id === listTab; }));
    }

    var tablist = h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Prayer lists' },
      tabs.map(function (t) {
        return h('button', {
          class: 'chip' + (t.id === 'praise' ? ' praise' : ''), type: 'button', role: 'tab',
          'aria-selected': t.id === listTab ? 'true' : 'false',
          onclick: function () { listTab = t.id; store.set('listTab', t.id); drawPrayers(g, el); }
        }, t.name);
      }));

    var start = h('button', { class: 'btn block pt-start', type: 'button', onclick: function () { showPrayerSetup(g); } },
      svg('M12 6v6l4 2|M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20'), 'Start prayer time');
    var request = h('button', { class: 'btn block secondary pt-start', type: 'button', onclick: function () { showRequest(g); } },
      svg('M12 5v14|M5 12h14'), 'Request a prayer');

    var pending = pdata.prayers.filter(function (p) { return p.status === 'pending'; });
    var queue = null;
    if (isApprover(g)) {
      state.pendingPrayers = pending.length;
      setBadge(g, 0, pending.length);
      if (pending.length) {
        queue = h('section', { class: 'queue' },
          h('h2', { class: 'section-title', text: 'Waiting for approval (' + pending.length + ')' }),
          h('ul', { class: 'prayers' }, pending.map(function (p) { return queueItem(g, p); })));
      }
    } else {
      var mine = pending.filter(function (p) { return state.user && p.requested_by === state.user.id; });
      if (mine.length) {
        queue = h('section', { class: 'queue' },
          h('h2', { class: 'section-title', text: 'Your requests waiting for approval' }),
          h('ul', { class: 'prayers' }, mine.map(function (p) {
            return h('li', {}, h('div', { class: 'prayer-item static' },
              h('span', { class: 'prayer-title', text: p.title }),
              p.body ? h('span', { class: 'prayer-snippet', text: snippet(p.body) }) : null,
              h('span', { class: 'prayer-meta' }, flags(p), h('span', { text: 'Sent ' + shortDate(p.created_at) }))));
          })));
      }
    }

    var body;
    if (!shown.length) {
      var msg = listTab === 'praise'
        ? 'When an approver marks a prayer answered, it moves here so the group can give thanks.'
        : pdata.prayers.length ? 'No prayers in this list right now.' : 'Your group has no prayers yet. Requests will show up here once they\'re approved.';
      body = h('div', { class: 'card empty-state' }, h('p', { text: msg }));
    } else {
      body = h('ul', { class: 'prayers' }, shown.map(function (p) {
        var n = totalFor(p.id);
        return h('li', {},
          h('button', { class: 'prayer-item', type: 'button', onclick: function () { showPrayer(g, p); } },
            h('span', { class: 'prayer-title', text: p.title }),
            p.body ? h('span', { class: 'prayer-snippet', text: snippet(p.body) }) : null,
            h('span', { class: 'prayer-meta' },
              p.status === 'active' ? flags(p) : null,
              listTab === 'all' || listTab === 'praise' ? (listName(p.list_id) ? h('span', { text: listName(p.list_id) }) : null) : null,
              listTab === 'praise' && p.answered_at ? h('span', { text: 'Answered ' + shortDate(p.answered_at) }) : null,
              h('span', { class: 'count', text: prayedLabel(n) }))));
      }));
    }

    el.replaceChildren.apply(el, [h('div', { class: 'actions' }, active.length ? start : null, request), queue, tablist, body].filter(Boolean));
    // Bring the selected list tab into view by scrolling the tab row sideways only (never the page).
    var sel = tablist.querySelector('[aria-selected="true"]');
    if (sel) tablist.scrollLeft = Math.max(0, sel.offsetLeft - tablist.offsetLeft - 16);
  }

  // First meaningful line of the prayer, skipping the "Heavenly Father," greeting.
  function snippet(body) {
    var lines = String(body).split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var line = lines.filter(function (s) { return !/^(heavenly father|dear (lord|god|father)|father|lord)[,.!]?$/i.test(s); })[0] || lines[0] || '';
    return line.length > 120 ? line.slice(0, 117).replace(/\s+\S*$/, '') + '…' : line;
  }
  function shortDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; }
  }
  function whenLabel(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }
  // "Urgent" chip and "Pray at …" note for a prayer.
  function flags(p) {
    var out = [];
    if (p.urgent) out.push(h('span', { class: 'flag urgent', text: 'Urgent' }));
    if (p.pray_at) {
      var past = new Date(p.pray_at).getTime() < Date.now();
      out.push(h('span', { class: 'flag when' + (past ? ' past' : ''), text: (past ? 'Prayed at ' : 'Pray at ') + whenLabel(p.pray_at) }));
    }
    return out.length ? out : null;
  }
  function urgentFirst(list) {
    return list.slice().sort(function (a, b) { return (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0); });
  }
  // datetime-local wants "YYYY-MM-DDTHH:MM" in the phone's own time zone.
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // Urgent checkbox and optional "pray at" time, shared by the request form and the editor.
  function urgencyFields(prefix, urgent, prayAt) {
    var box = h('input', { type: 'checkbox', id: prefix + '-urgent', checked: !!urgent });
    var when = h('input', { type: 'datetime-local', id: prefix + '-when', value: toLocalInput(prayAt) });
    var clear = h('button', { class: 'btn small quiet', type: 'button', text: 'Clear time', onclick: function () { when.value = ''; } });
    var el = h('div', { class: 'urgency' },
      h('label', { class: 'check-row urgent-row', for: prefix + '-urgent' }, box,
        h('span', { class: 'check-name' }, 'This is urgent',
          h('span', { class: 'hint', text: 'Everyone with notifications on gets a push once it\'s approved.' }))),
      h('div', { class: 'field' },
        h('label', { for: prefix + '-when', text: 'Ask the group to pray at a specific time (optional)' },
          h('span', { class: 'hint', text: 'Like the start of a surgery. Everyone gets a "Pray now" push at that time.' })),
        h('div', { class: 'row when-row' }, when, clear)));
    return {
      el: el,
      read: function () {
        var at = null;
        if (when.value) {
          var d = new Date(when.value);
          if (isNaN(d.getTime())) throw new Error('That time doesn\'t look right.');
          at = d.toISOString();
        }
        return { urgent: box.checked, pray_at: at };
      }
    };
  }

  function markPrayed(p) {
    return sb.from('prayed_marks').insert({ prayer_id: p.id, user_id: state.user.id }).then(must).then(function () {
      var t = pdata.totals[p.id] || (pdata.totals[p.id] = { total: 0, mine: 0 });
      t.total += 1;
      t.mine += 1;
      return t;
    });
  }

  // Full text of one prayer, with "I prayed".
  function showPrayer(g, p) {
    var count = h('p', { class: 'prayer-count', 'aria-live': 'polite' });
    function drawCount() {
      var c = pdata.totals[p.id] || { total: 0, mine: 0 };
      count.textContent = prayedLabel(c.total) + (c.mine ? ' · you ' + c.mine + 'x' : '');
    }
    drawCount();
    var err = h('p', { class: 'error', role: 'alert' });
    var prayed = null;
    if (p.status === 'active') {
      prayed = h('button', { class: 'btn block', type: 'button', text: 'I prayed' });
      prayed.addEventListener('click', busy(prayed, err, function () {
        return markPrayed(p).then(function () { drawCount(); toast('Amen. Thank you for praying.'); });
      }));
    }
    var back = h('button', { class: 'btn quiet back', type: 'button', onclick: function () { showGroup(g); } },
      svg('M15 18l-6-6 6-6'), 'Back');

    var manage = null;
    if (isApprover(g)) {
      var manageErr = h('p', { class: 'error', role: 'alert' });
      var edit = h('button', { class: 'btn small secondary', type: 'button', text: 'Edit', onclick: function () { showEditor(g, p); } });
      var move;
      if (p.status === 'active') {
        move = h('button', { class: 'btn small', type: 'button', text: 'Mark answered' });
        move.addEventListener('click', busy(move, manageErr, function () {
          if (!confirm('Mark "' + p.title + '" as answered? It moves to Praise and leaves prayer time.')) return;
          return setStatus(p, 'answered').then(function () { toast('Moved to Praise. Thank You, Lord!'); listTab = 'praise'; showGroup(g); });
        }));
      } else {
        move = h('button', { class: 'btn small secondary', type: 'button', text: 'Move back to prayers' });
        move.addEventListener('click', busy(move, manageErr, function () {
          return setStatus(p, 'active').then(function () { toast('Moved back to the prayer list.'); showGroup(g); });
        }));
      }
      var remove = h('button', { class: 'btn small danger', type: 'button', text: 'Remove' });
      remove.addEventListener('click', busy(remove, manageErr, function () {
        if (!confirm('Remove "' + p.title + '"? It will no longer show for the group.')) return;
        return setStatus(p, 'removed').then(function () { toast('Prayer removed.'); showGroup(g); });
      }));
      manage = h('section', { class: 'card manage' },
        h('h2', { class: 'section-title', text: 'Approver tools' }),
        h('div', { class: 'row' }, move, edit, remove),
        manageErr);
    }

    render(h('div', { class: 'reader' },
      h('header', { class: 'reader-bar' }, back),
      h('main', { class: 'reader-body' },
        h('p', { class: 'reader-list', text: p.status === 'answered' ? 'Praise' + (listName(p.list_id) ? ' · ' + listName(p.list_id) : '') : listName(p.list_id) }),
        h('h1', { text: p.title }),
        p.status === 'active' && (p.urgent || p.pray_at) ? h('p', { class: 'prayer-meta reader-flags' }, flags(p)) : null,
        p.status === 'answered' && p.answered_at ? h('p', { class: 'reader-answered', text: 'Answered ' + shortDate(p.answered_at) }) : null,
        h('div', { class: 'prayer-text', text: p.body || '' }),
        p.requester_name ? h('p', { class: 'reader-by', text: 'Requested by ' + p.requester_name }) : null,
        count,
        prayed,
        err,
        manage)));
  }

  function setStatus(p, status) {
    return sb.from('prayers').update({ status: status }).eq('id', p.id).select().then(mustChange);
  }

  // One pending request in the approver queue: Approve / Edit / Decline.
  function queueItem(g, p) {
    var err = h('p', { class: 'error', role: 'alert' });
    var approve = h('button', { class: 'btn small', type: 'button', text: 'Approve' });
    approve.addEventListener('click', busy(approve, err, function () {
      return setStatus(p, 'active').then(function () { toast('Approved. It\'s on the prayer list now.'); showGroup(g); });
    }));
    var edit = h('button', { class: 'btn small secondary', type: 'button', text: 'Edit', onclick: function () { showEditor(g, p); } });
    var decline = h('button', { class: 'btn small danger', type: 'button', text: 'Decline' });
    decline.addEventListener('click', busy(decline, err, function () {
      if (!confirm('Decline "' + p.title + '"? It won\'t be shared with the group.')) return;
      return setStatus(p, 'removed').then(function () { toast('Request declined.'); showGroup(g); });
    }));
    var from = p.requester_name || (roster[p.requested_by] || '');
    return h('li', { class: 'queue-item' },
      h('div', { class: 'prayer-item static' },
        h('span', { class: 'prayer-title', text: p.title }),
        h('span', { class: 'prayer-full', text: p.body || '' }),
        h('span', { class: 'prayer-meta' },
          flags(p),
          listName(p.list_id) ? h('span', { text: listName(p.list_id) }) : null,
          from ? h('span', { text: 'From ' + from }) : null,
          h('span', { text: shortDate(p.created_at) })),
        h('div', { class: 'row' }, approve, edit, decline),
        err));
  }

  // Names for "From …" in the approver queue (approvers can read the roster).
  var roster = {};
  function loadRosterNames(g) {
    return sb.rpc('group_roster', { p_group_id: g.group_id }).then(must).then(function (rows) {
      roster = {};
      rows.forEach(function (r) { roster[r.user_id] = r.display_name || ''; });
    }).catch(function () {});
  }

  // ---------------------------------------------------------------------------
  // Request a prayer: who, what to pray for, your name, list, urgent / pray-at time
  // ---------------------------------------------------------------------------

  function listSelect(id, selected) {
    if (!pdata.lists.length) return null;
    var sel = h('select', { id: id },
      h('option', { value: '', text: 'No list' }),
      pdata.lists.map(function (l) {
        return h('option', { value: l.id, text: l.name, selected: l.id === selected });
      }));
    return h('div', { class: 'field' }, h('label', { for: id, text: 'List' }), sel);
  }

  function readerShell(g, title, children, onBack) {
    render(h('div', { class: 'reader' },
      h('header', { class: 'reader-bar' },
        h('button', { class: 'btn quiet back', type: 'button', onclick: onBack || function () { showGroup(g); } }, svg('M15 18l-6-6 6-6'), 'Back')),
      h('main', { class: 'reader-body' }, h('h1', { text: title }), children)));
  }

  function showRequest(g) {
    var err = h('p', { class: 'error', role: 'alert' });
    var who = h('input', { type: 'text', id: 'req-who', maxlength: '120', required: true, 'data-autofocus': true });
    var need = h('textarea', { id: 'req-need', rows: '6', maxlength: '4000', required: true });
    var name = h('input', { type: 'text', id: 'req-name', maxlength: '80', autocomplete: 'name' });
    var lists = listSelect('req-list', listTab !== 'all' && listTab !== 'praise' ? listTab : '');
    var urgency = urgencyFields('req');
    var direct = isApprover(g) || g.require_approval === false;
    var submit = h('button', { class: 'btn block', type: 'submit', text: direct ? 'Post prayer' : 'Send for approval' });
    var form = h('form', { class: 'card', novalidate: true },
      h('div', { class: 'field' },
        h('label', { for: 'req-who', text: 'Who is this prayer for?' },
          h('span', { class: 'hint', text: 'A first name is fine, like "my brother Sam".' })),
        who),
      h('div', { class: 'field' },
        h('label', { for: 'req-need', text: 'What should we pray for?' },
          h('span', { class: 'hint', text: 'Your group will see this. Share what you\'re comfortable with.' })),
        need),
      h('div', { class: 'field' },
        h('label', { for: 'req-name', text: 'Your name (optional)' },
          h('span', { class: 'hint', text: 'Shown as "Requested by". Leave blank to keep it private.' })),
        name),
      lists,
      urgency.el,
      submit,
      err);
    form.addEventListener('submit', busy(submit, err, function () {
      var w = who.value.trim().replace(/\s+/g, ' ');
      var n = need.value.trim();
      if (!w) throw new Error('Say who this prayer is for.');
      if (!n) throw new Error('Say what we should pray for.');
      var u = urgency.read();
      if (u.pray_at && new Date(u.pray_at).getTime() < Date.now() - 60000) throw new Error('Choose a pray-at time that hasn\'t passed yet.');
      submit.textContent = 'Sending…';
      return sb.from('prayers').insert({
        group_id: g.group_id,
        list_id: (lists && lists.querySelector('select').value) || null,
        title: w,
        body: n,
        status: direct ? 'active' : 'pending',
        requested_by: state.user.id,
        requester_name: name.value.trim() || null,
        urgent: u.urgent,
        pray_at: u.pray_at
      }).then(must).then(function () {
        toast(direct ? 'Posted. Your group can pray for this now.' : 'Sent. An approver will review it soon.');
        state.tab = 'prayers';
        showGroup(g);
      });
    }));
    readerShell(g, 'Request a prayer', [
      h('p', { class: 'lede', text: direct ? 'Tell your group who needs prayer and what to pray for.' : 'Tell your group who needs prayer and what to pray for. An approver will review it first.' }),
      form]);
  }

  // Approvers edit a prayer (pending, active, or answered). Pending ones can be saved and approved at once.
  function showEditor(g, p) {
    var err = h('p', { class: 'error', role: 'alert' });
    var title = h('input', { type: 'text', id: 'edit-title', maxlength: '120', required: true, value: p.title });
    var body = h('textarea', { id: 'edit-body', class: 'prayer-edit', rows: '10', maxlength: '4000' });
    body.value = p.body || '';
    var name = h('input', { type: 'text', id: 'edit-name', maxlength: '80', value: p.requester_name || '' });
    var lists = listSelect('edit-list', p.list_id || '');
    var urgency = urgencyFields('edit', p.urgent, p.pray_at);
    var isPending = p.status === 'pending';
    var save = h('button', { class: 'btn block', type: 'submit', text: isPending ? 'Save and approve' : 'Save' });
    var saveOnly = isPending ? h('button', { class: 'btn block secondary', type: 'button', text: 'Save without approving' }) : null;
    var form = h('form', { class: 'card stack', novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'edit-title', text: 'Who is this prayer for?' }), title),
      h('div', { class: 'field' }, h('label', { for: 'edit-body', text: 'What should we pray for?' }), body),
      lists,
      urgency.el,
      h('div', { class: 'field' }, h('label', { for: 'edit-name', text: 'Requested by (optional)' }), name),
      save,
      saveOnly,
      err);
    function changes(approve) {
      var t = title.value.trim().replace(/\s+/g, ' ');
      if (!t) throw new Error('Say who this prayer is for.');
      var c = { title: t, body: body.value.trim(), requester_name: name.value.trim() || null };
      if (lists) c.list_id = lists.querySelector('select').value || null;
      var u = urgency.read();
      c.urgent = u.urgent;
      c.pray_at = u.pray_at;
      if (approve) c.status = 'active';
      return c;
    }
    function run(approve) {
      return sb.from('prayers').update(changes(approve)).eq('id', p.id).select().then(mustChange).then(function () {
        toast(approve ? 'Saved and approved.' : 'Saved.');
        showGroup(g);
      });
    }
    form.addEventListener('submit', busy(save, err, function () { return run(isPending); }));
    if (saveOnly) saveOnly.addEventListener('click', busy(saveOnly, err, function () { return run(false); }));
    readerShell(g, isPending ? 'Review request' : 'Edit prayer', [form]);
  }

  // ---------------------------------------------------------------------------
  // Prayer time: choose length and lists, shuffle, one card at a time, countdown ring
  // ---------------------------------------------------------------------------

  var LENGTHS = [3, 5, 10, 15, 20, 30];

  function showPrayerSetup(g) {
    var minutes = Number(store.get('ptMinutes')) || 10;
    if (LENGTHS.indexOf(minutes) < 0) minutes = 10;
    var active = pdata.prayers.filter(function (p) { return p.status === 'active'; });
    var lists = pdata.lists.filter(function (l) { return active.some(function (p) { return p.list_id === l.id; }); });
    var unlisted = active.filter(function (p) { return !p.list_id || !listName(p.list_id); }).length;
    var saved = (store.get('ptLists:' + g.group_id) || '').split(',').filter(Boolean);

    var lengthGroup = h('div', { class: 'chips wrap', role: 'radiogroup', 'aria-labelledby': 'pt-len' },
      LENGTHS.map(function (m) {
        var b = h('button', {
          class: 'chip', type: 'button', role: 'radio', 'aria-checked': m === minutes ? 'true' : 'false',
          onclick: function () {
            minutes = m;
            lengthGroup.querySelectorAll('[role="radio"]').forEach(function (x) { x.setAttribute('aria-checked', 'false'); });
            b.setAttribute('aria-checked', 'true');
          }
        }, m + ' min');
        return b;
      }));

    var boxes = lists.map(function (l) {
      var n = active.filter(function (p) { return p.list_id === l.id; }).length;
      var cb = h('input', { type: 'checkbox', value: l.id, checked: !saved.length || saved.indexOf(l.id) >= 0 });
      return h('label', { class: 'check-row' }, cb, h('span', { class: 'check-name', text: l.name }), h('span', { class: 'person-meta', text: String(n) }));
    });
    var otherBox = null;
    if (unlisted) {
      var ocb = h('input', { type: 'checkbox', value: '_none', checked: !saved.length || saved.indexOf('_none') >= 0 });
      otherBox = h('label', { class: 'check-row' }, ocb, h('span', { class: 'check-name', text: lists.length ? 'Other' : 'All prayers' }), h('span', { class: 'person-meta', text: String(unlisted) }));
    }

    var err = h('p', { class: 'error', role: 'alert' });
    var begin = h('button', { class: 'btn block', type: 'button', text: 'Begin' });
    begin.addEventListener('click', function () {
      var chosen = Array.prototype.map.call(document.querySelectorAll('.check-row input:checked'), function (x) { return x.value; });
      var stack = active.filter(function (p) {
        var key = p.list_id && listName(p.list_id) ? p.list_id : '_none';
        return chosen.indexOf(key) >= 0;
      });
      if (!stack.length) { err.textContent = 'Choose at least one list.'; return; }
      store.set('ptMinutes', String(minutes));
      store.set('ptLists:' + g.group_id, chosen.join(','));
      startPrayerTime(g, minutes, stack);
    });

    render(h('div', { class: 'reader' },
      h('header', { class: 'reader-bar' },
        h('button', { class: 'btn quiet back', type: 'button', onclick: function () { showGroup(g); } }, svg('M15 18l-6-6 6-6'), 'Back')),
      h('main', { class: 'reader-body' },
        h('h1', { text: 'Prayer time' }),
        h('p', { class: 'lede', text: 'Upheld shuffles your prayers into one stack and shows one at a time. Tap to move to the next.' }),
        h('h2', { class: 'section-title', id: 'pt-len', text: 'How long' }),
        lengthGroup,
        h('h2', { class: 'section-title', text: 'Which lists' }),
        h('div', { class: 'card checks' }, boxes, otherBox),
        begin,
        err)));
  }

  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Soft two-note chime made with Web Audio (no audio files).
  function makeChime() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return { unlock: function () {}, play: function () {} };
    var ctx = null;
    function unlock() {
      try {
        if (!ctx) ctx = new Ctx();
        if (ctx.state === 'suspended') ctx.resume();
        // A silent blip during the tap lets iOS play the chime later without a tap.
        var o = ctx.createOscillator(), gn = ctx.createGain();
        gn.gain.value = 0;
        o.connect(gn); gn.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + 0.01);
      } catch (e) {}
    }
    function note(freq, at, dur) {
      var o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      gn.gain.setValueAtTime(0.0001, at);
      gn.gain.exponentialRampToValueAtTime(0.22, at + 0.04);
      gn.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(gn); gn.connect(ctx.destination);
      o.start(at); o.stop(at + dur + 0.05);
    }
    function play() {
      try {
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();
        var t = ctx.currentTime + 0.05;
        note(784, t, 1.6);         // G5
        note(523.25, t + 0.55, 2.4); // C5
      } catch (e) {}
    }
    return { unlock: unlock, play: play };
  }

  function startPrayerTime(g, minutes, prayers) {
    $toast.hidden = true;
    var chime = makeChime();
    chime.unlock();

    var totalMs = minutes * 60 * 1000;
    var elapsedBefore = 0;       // ms banked before the current run
    var runStart = Date.now();   // null while paused
    var stack = shuffle(prayers);
    var index = 0;
    var prayedCount = 0;
    var finished = false;
    var tick = null;
    var wakeLock = null;

    function requestWake() {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
    }
    function releaseWake() {
      if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    }
    function onVisible() { if (document.visibilityState === 'visible' && !finished && runStart) requestWake(); }
    document.addEventListener('visibilitychange', onVisible);
    requestWake();

    function elapsed() { return elapsedBefore + (runStart ? Date.now() - runStart : 0); }

    // Countdown ring
    var R = 44, C = 2 * Math.PI * R;
    var ns = 'http://www.w3.org/2000/svg';
    var ring = document.createElementNS(ns, 'svg');
    ring.setAttribute('viewBox', '0 0 100 100');
    ring.setAttribute('class', 'ring');
    ring.setAttribute('aria-hidden', 'true');
    var bg = document.createElementNS(ns, 'circle');
    bg.setAttribute('cx', '50'); bg.setAttribute('cy', '50'); bg.setAttribute('r', String(R)); bg.setAttribute('class', 'ring-bg');
    var fg = document.createElementNS(ns, 'circle');
    fg.setAttribute('cx', '50'); fg.setAttribute('cy', '50'); fg.setAttribute('r', String(R)); fg.setAttribute('class', 'ring-fg');
    fg.setAttribute('stroke-dasharray', String(C));
    fg.setAttribute('transform', 'rotate(-90 50 50)');
    ring.appendChild(bg); ring.appendChild(fg);
    var timeText = h('span', { class: 'ring-time' });
    var timer = h('div', { class: 'ring-wrap', role: 'timer', 'aria-label': 'Time remaining' }, ring, timeText);

    var cardList = h('p', { class: 'pt-list' });
    var cardTitle = h('h1', { class: 'pt-title' });
    var cardBody = h('div', { class: 'pt-body' });
    // The card is a large tap target; the "Next prayer" button is the accessible way to advance.
    var card = h('article', { class: 'pt-card', 'aria-live': 'polite', onclick: next },
      cardList, cardTitle, cardBody, h('span', { class: 'pt-hint', 'aria-hidden': 'true', text: 'Tap for the next prayer' }));
    var progress = h('p', { class: 'pt-progress', 'aria-live': 'polite' });

    var pauseBtn = h('button', { class: 'btn secondary', type: 'button', text: 'Pause', onclick: togglePause });
    var nextBtn = h('button', { class: 'btn', type: 'button', text: 'Next prayer', onclick: next });
    var endBtn = h('button', { class: 'btn quiet', type: 'button', text: 'End', onclick: function () { finish(false); } });

    render(h('div', { class: 'pt' },
      h('header', { class: 'pt-top' }, timer, progress),
      h('main', { class: 'pt-main' }, card),
      h('footer', { class: 'pt-controls' }, pauseBtn, nextBtn, endBtn)));

    function showCard() {
      var p = stack[index];
      cardList.textContent = listName(p.list_id);
      cardTitle.textContent = p.title;
      cardBody.textContent = p.body || '';
      card.scrollTop = 0;
      progress.textContent = prayedCount ? 'Prayed for ' + prayedCount : '';
    }

    function drawTime() {
      var left = Math.max(0, totalMs - elapsed());
      var s = Math.ceil(left / 1000);
      timeText.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      fg.setAttribute('stroke-dashoffset', String(C * (1 - left / totalMs)));
      if (left <= 0 && !finished) finish(true);
    }

    function next() {
      if (finished || !runStart) return;
      markPrayed(stack[index]).catch(function () {});
      prayedCount += 1;
      index += 1;
      if (index >= stack.length) {
        // Prayed through everything: reshuffle and keep going, avoiding an immediate repeat.
        var last = stack[stack.length - 1];
        stack = shuffle(prayers);
        if (stack.length > 1 && stack[0] === last) { stack.push(stack.shift()); }
        index = 0;
        toast('You\'ve prayed through every prayer. Starting again.');
      }
      showCard();
    }

    function togglePause() {
      if (finished) return;
      if (runStart) {
        elapsedBefore += Date.now() - runStart;
        runStart = null;
        pauseBtn.textContent = 'Resume';
        nextBtn.disabled = true;
        card.classList.add('paused');
        releaseWake();
      } else {
        runStart = Date.now();
        pauseBtn.textContent = 'Pause';
        nextBtn.disabled = false;
        card.classList.remove('paused');
        requestWake();
      }
      drawTime();
    }

    function cleanup() {
      finished = true;
      clearInterval(tick);
      releaseWake();
      document.removeEventListener('visibilitychange', onVisible);
    }

    // timeUp: the card on screen when time runs out counts as prayed too.
    function finish(timeUp) {
      if (finished) return;
      if (!timeUp && prayedCount === 0 && elapsed() < 5000) { cleanup(); showGroup(g); return; }
      if (!timeUp && !confirm('End prayer time now?')) return;
      if (timeUp) {
        markPrayed(stack[index]).catch(function () {});
        prayedCount += 1;
        chime.play();
      }
      cleanup();
      showAmen(g, prayedCount);
    }

    showCard();
    drawTime();
    tick = setInterval(drawTime, 250);
  }

  function showAmen(g, count) {
    render(h('div', { class: 'amen' },
      h('main', { class: 'amen-inner' },
        h('img', { src: '../icons/icon-192.png', alt: '' }),
        h('h1', { text: 'Amen' }),
        h('p', { class: 'amen-count', text: count === 1 ? 'You prayed for 1 prayer.' : 'You prayed for ' + count + ' prayers.' }),
        h('p', { class: 'amen-verse', text: '“His hands were steady until the going down of the sun.” Exodus 17:12' }),
        h('button', { class: 'btn block', type: 'button', text: 'Done', 'data-autofocus': true, onclick: function () { state.tab = 'prayers'; showGroup(g); } }))));
  }

  // People: pending join requests (approvers), then members. Owner can change roles and remove people.
  function renderPeople(g, el) {
    el.replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));
    sb.rpc('group_roster', { p_group_id: g.group_id }).then(must).then(function (rows) {
      var pending = rows.filter(function (r) { return r.status === 'pending'; });
      var active = rows.filter(function (r) { return r.status === 'active'; });
      state.pendingCount = pending.length;
      var parts = [];

      if (isApprover(g)) {
        parts.push(h('h2', { class: 'section-title', text: 'Waiting to join' }));
        parts.push(pending.length
          ? h('ul', { class: 'people' }, pending.map(function (p) { return pendingRow(g, p); }))
          : h('div', { class: 'people' }, h('p', { class: 'empty', text: 'No one is waiting right now.' })));
      }

      parts.push(h('h2', { class: 'section-title', text: 'Members (' + active.length + ')' }));
      parts.push(h('ul', { class: 'people' }, active.map(function (p) { return memberRow(g, p); })));

      if (isOwner(g)) {
        parts.push(h('p', { class: 'hint', text: 'Approvers can let new people in and review new prayer requests.' }));
      }
      el.replaceChildren.apply(el, parts);
    }).catch(function (err) {
      el.replaceChildren(h('p', { class: 'error', text: friendlyError(err) }));
    });
  }

  function personName(p) {
    return p.display_name || 'Unnamed member';
  }

  function joinedLabel(p) {
    try {
      return 'Asked ' + new Date(p.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function pendingRow(g, p) {
    var err = h('p', { class: 'error', role: 'alert' });
    var approve = h('button', { class: 'btn small', type: 'button', text: 'Approve' });
    var decline = h('button', { class: 'btn small danger', type: 'button', text: 'Decline' });
    approve.addEventListener('click', busy(approve, err, function () {
      return sb.from('group_members').update({ status: 'active' })
        .eq('group_id', g.group_id).eq('user_id', p.user_id).select().then(mustChange)
        .then(function () { toast(personName(p) + ' can now see the group.'); showGroup(g); });
    }));
    decline.addEventListener('click', busy(decline, err, function () {
      if (!confirm('Decline ' + personName(p) + '\'s request to join?')) return;
      return sb.from('group_members').delete()
        .eq('group_id', g.group_id).eq('user_id', p.user_id).select().then(mustChange)
        .then(function () { toast('Request declined.'); showGroup(g); });
    }));
    return h('li', { class: 'person' },
      h('div', { class: 'person-head' },
        h('div', { class: 'person-name' }, personName(p), h('div', { class: 'person-meta', text: joinedLabel(p) }))),
      h('div', { class: 'row' }, approve, decline),
      err);
  }

  function memberRow(g, p) {
    var isMe = state.user && p.user_id === state.user.id;
    var err = h('p', { class: 'error', role: 'alert' });
    var actions = null;

    if (isOwner(g) && p.role !== 'owner') {
      var toggle = h('button', {
        class: 'btn small secondary', type: 'button',
        text: p.role === 'approver' ? 'Remove approver' : 'Make approver'
      });
      toggle.addEventListener('click', busy(toggle, err, function () {
        var next = p.role === 'approver' ? 'member' : 'approver';
        return sb.from('group_members').update({ role: next })
          .eq('group_id', g.group_id).eq('user_id', p.user_id).select().then(mustChange)
          .then(function () {
            toast(next === 'approver' ? personName(p) + ' is now an approver.' : personName(p) + ' is now a member.');
            showGroup(g);
          });
      }));
      var remove = h('button', { class: 'btn small danger', type: 'button', text: 'Remove' });
      remove.addEventListener('click', busy(remove, err, function () {
        if (!confirm('Remove ' + personName(p) + ' from ' + g.name + '? They will lose access to the group\'s prayers.')) return;
        return sb.from('group_members').delete()
          .eq('group_id', g.group_id).eq('user_id', p.user_id).select().then(mustChange)
          .then(function () { toast(personName(p) + ' was removed.'); showGroup(g); });
      }));
      actions = h('div', { class: 'row' }, toggle, remove);
    }

    return h('li', { class: 'person' },
      h('div', { class: 'person-head' },
        h('div', { class: 'person-name' }, personName(p), isMe ? h('span', { class: 'person-meta', text: ' (you)' }) : null),
        p.role !== 'member' ? h('span', { class: 'role ' + p.role, text: p.role === 'owner' ? 'Owner' : 'Approver' }) : null),
      actions,
      err);
  }

  // Group: invite code, settings (owner), your name, leave, sign out.
  function renderGroupSettings(g, el) {
    var parts = [];

    if (isApprover(g) && g.invite_code) {
      var shareBtn = h('button', { class: 'btn small', type: 'button', text: navigator.share ? 'Share' : 'Copy' });
      shareBtn.addEventListener('click', function () {
        var text = 'Join ' + g.name + ' on Upheld. Install the app from https://upheld.macdwellings.com, sign in, and enter invite code ' + g.invite_code;
        if (navigator.share) {
          navigator.share({ title: 'Join ' + g.name + ' on Upheld', text: text }).catch(function () {});
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(g.invite_code).then(function () { toast('Invite code copied.'); }, function () {});
        }
      });
      var inviteErr = h('p', { class: 'error', role: 'alert' });
      var rotate = isOwner(g) ? h('button', { class: 'btn small quiet', type: 'button', text: 'Make a new code' }) : null;
      if (rotate) {
        rotate.addEventListener('click', busy(rotate, inviteErr, function () {
          if (!confirm('Make a new invite code? The old code will stop working. People already in the group stay in.')) return;
          return sb.rpc('rotate_invite_code', { p_group_id: g.group_id }).then(must).then(function () {
            return loadGroups();
          }).then(function () { toast('New invite code ready.'); showGroup(currentGroup()); });
        }));
      }
      parts.push(h('section', { class: 'card' },
        h('h2', { text: 'Invite people' }),
        h('p', { class: 'hint', text: 'Share this code. New people join as pending until an approver lets them in.' }),
        h('div', { class: 'invite', text: g.invite_code, 'aria-label': 'Invite code ' + g.invite_code.split('').join(' ') }),
        h('div', { class: 'row' }, shareBtn, rotate),
        inviteErr));
    }

    if (isApprover(g)) parts.push(listsCard(g));

    if (isOwner(g)) {
      var settingsErr = h('p', { class: 'error', role: 'alert' });
      var toggle = h('input', { type: 'checkbox', id: 'require-approval', role: 'switch', checked: g.require_approval !== false });
      toggle.addEventListener('change', function () {
        var want = toggle.checked;
        toggle.disabled = true;
        settingsErr.textContent = '';
        sb.from('groups').update({ require_approval: want }).eq('id', g.group_id).select().then(mustChange)
          .then(function () {
            g.require_approval = want;
            toast(want ? 'New requests will wait for approval.' : 'New requests will post right away.');
          })
          .catch(function (e) { toggle.checked = !want; settingsErr.textContent = friendlyError(e); })
          .then(function () { toggle.disabled = false; });
      });

      var renameInput = h('input', { type: 'text', id: 'rename', maxlength: '80', value: g.name });
      var renameBtn = h('button', { class: 'btn small secondary', type: 'submit', text: 'Save name' });
      var renameForm = h('form', { novalidate: true },
        h('div', { class: 'field' }, h('label', { for: 'rename', text: 'Group name' }), renameInput),
        renameBtn);
      renameForm.addEventListener('submit', busy(renameBtn, settingsErr, function () {
        var name = renameInput.value.trim().replace(/\s+/g, ' ');
        if (!name) throw new Error('Enter a group name.');
        return sb.from('groups').update({ name: name }).eq('id', g.group_id).select().then(mustChange)
          .then(loadGroups)
          .then(function () { toast('Group renamed.'); showGroup(currentGroup()); });
      }));

      parts.push(h('section', { class: 'card' },
        h('h2', { text: 'Settings' }),
        h('div', { class: 'setting' },
          h('div', { class: 'setting-text' },
            h('label', { for: 'require-approval', text: 'Require approval for new requests' }),
            h('p', { text: 'When on, prayer requests wait for an approver before the group sees them.' })),
          h('div', { class: 'switch' }, toggle, h('span', { class: 'track', 'aria-hidden': 'true' }))),
        h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:18px 0' }),
        renameForm,
        h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:18px 0' }),
        h('div', { class: 'setting' },
          h('div', { class: 'setting-text' },
            h('strong', { text: 'Transfer ownership' }),
            h('p', { text: 'Hand this group to another member. You\'ll stay on as an approver.' })),
          h('button', { class: 'btn small secondary', type: 'button', text: 'Transfer', onclick: function () { showTransfer(g); } })),
        settingsErr));
    }

    parts.push(notificationsCard());

    var accountErr = h('p', { class: 'error', role: 'alert' });
    var leaveOrDelete;
    if (isOwner(g)) {
      leaveOrDelete = h('button', { class: 'btn danger block', type: 'button', text: 'Delete this group' });
      leaveOrDelete.addEventListener('click', busy(leaveOrDelete, accountErr, function () {
        var typed = prompt('This permanently deletes ' + g.name + ', its lists, and its prayers for everyone.\n\nType the group name to confirm:');
        if (typed == null) return;
        if (typed.trim() !== g.name) throw new Error('The name didn\'t match, so nothing was deleted.');
        return sb.from('groups').delete().eq('id', g.group_id).select().then(mustChange)
          .then(function () { state.groupId = null; return loadGroups(); })
          .then(function () { toast('Group deleted.'); route(); });
      }));
    } else {
      leaveOrDelete = h('button', { class: 'btn danger block', type: 'button', text: 'Leave this group' });
      leaveOrDelete.addEventListener('click', busy(leaveOrDelete, accountErr, function () {
        if (!confirm('Leave ' + g.name + '? You\'ll need a new invite and approval to come back.')) return;
        return sb.from('group_members').delete().eq('group_id', g.group_id).eq('user_id', state.user.id).select()
          .then(mustChange)
          .then(function () { state.groupId = null; return loadGroups(); })
          .then(function () { toast('You left ' + g.name + '.'); route(); });
      }));
    }

    parts.push(h('section', { class: 'card stack' },
      h('h2', { text: 'You' }),
      h('p', {}, 'Signed in as ', h('strong', { text: (state.profile && state.profile.display_name) || '' }),
        state.user && state.user.email ? h('span', { class: 'person-meta', text: ' · ' + state.user.email }) : null,
        '. Your role here: ', h('strong', { text: g.role === 'owner' ? 'Owner' : g.role === 'approver' ? 'Approver' : 'Member' }), '.'),
      h('button', { class: 'btn secondary block', type: 'button', text: 'Change my name', onclick: function () { showName(false); } }),
      h('button', { class: 'btn secondary block', type: 'button', text: 'Join or start another group', onclick: showStart }),
      leaveOrDelete,
      h('button', { class: 'btn quiet block', type: 'button', text: 'Sign out', onclick: signOut }),
      accountErr));

    el.replaceChildren.apply(el, parts);
  }

  // ---------------------------------------------------------------------------
  // Transfer ownership (owner only)
  // ---------------------------------------------------------------------------

  function showTransfer(g) {
    var err = h('p', { class: 'error', role: 'alert' });
    var pick = h('select', { id: 'new-owner' }, h('option', { value: '', text: 'Loading…' }));
    var confirmInput = h('input', { type: 'text', id: 'confirm-name', autocomplete: 'off', placeholder: g.name });
    var go = h('button', { class: 'btn block danger', type: 'submit', text: 'Make them the owner' });
    var people = [];
    sb.rpc('group_roster', { p_group_id: g.group_id }).then(must).then(function (rows) {
      people = rows.filter(function (r) { return r.status === 'active' && r.user_id !== state.user.id; });
      pick.replaceChildren(h('option', { value: '', text: people.length ? 'Choose a member' : 'No other members yet' }));
      people.forEach(function (r) { pick.appendChild(h('option', { value: r.user_id, text: personName(r) })); });
    }).catch(function (e) { err.textContent = friendlyError(e); });

    var form = h('form', { class: 'card', novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'new-owner', text: 'New owner' }), pick),
      h('div', { class: 'field' },
        h('label', { for: 'confirm-name', text: 'Type the group name to confirm' },
          h('span', { class: 'hint', text: 'The new owner can choose approvers, change settings, and delete the group. You\'ll become an approver.' })),
        confirmInput),
      go,
      err);
    form.addEventListener('submit', busy(go, err, function () {
      var who = people.filter(function (r) { return r.user_id === pick.value; })[0];
      if (!who) throw new Error('Choose who should own the group.');
      if (confirmInput.value.trim() !== g.name) throw new Error('Type the group name exactly to confirm.');
      return sb.rpc('transfer_ownership', { p_group_id: g.group_id, p_new_owner: who.user_id }).then(must)
        .then(loadGroups)
        .then(function () {
          toast(personName(who) + ' is now the owner. You\'re an approver.');
          state.tab = 'group';
          showGroup(currentGroup());
        });
    }));
    readerShell(g, 'Transfer ownership', [
      h('p', { class: 'lede' }, 'Choose who will own ', h('strong', { text: g.name }), '.'),
      form], function () { state.tab = 'group'; showGroup(g); });
  }

  // ---------------------------------------------------------------------------
  // Notifications: this phone's push subscription, what to be notified about, daily reminder
  // ---------------------------------------------------------------------------

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function vapidKey() {
    var b64 = (cfg.vapidPublicKey || '').replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function currentSubscription() {
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); });
  }

  var DAY_LABELS = [['S', 'Sunday'], ['M', 'Monday'], ['T', 'Tuesday'], ['W', 'Wednesday'], ['T', 'Thursday'], ['F', 'Friday'], ['S', 'Saturday']];

  function notificationsCard() {
    var card = h('section', { class: 'card', id: 'notifications' }, h('h2', { text: 'Notifications' }));
    if (!cfg.vapidPublicKey) {
      card.appendChild(h('p', { class: 'hint', text: 'Notifications aren\'t switched on for Upheld yet.' }));
      return card;
    }
    if (!pushSupported()) {
      card.appendChild(h('p', { class: 'hint', text: 'This phone can\'t get notifications from Upheld here. On iPhone, update to iOS 16.4 or later and open Upheld from your home screen.' }));
      return card;
    }

    var err = h('p', { class: 'error', role: 'alert' });
    var status = h('p', { class: 'hint' });
    var toggleBtn = h('button', { class: 'btn small', type: 'button', text: 'Turn on notifications' });
    var prefs = h('div', { class: 'stack notif-prefs' });
    card.append(status, h('div', { class: 'row' }, toggleBtn), err, prefs);

    var settings = { urgent: true, scheduled: true, reminder_enabled: false, reminder_time: '07:00', reminder_days: [0, 1, 2, 3, 4, 5, 6] };

    function saveSettings(patch) {
      Object.assign(settings, patch);
      var row = {
        user_id: state.user.id,
        urgent: settings.urgent,
        scheduled: settings.scheduled,
        reminder_enabled: settings.reminder_enabled,
        reminder_time: settings.reminder_time,
        reminder_days: settings.reminder_days,
        timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York')
      };
      return sb.from('notification_settings').upsert(row).select().then(mustChange);
    }

    function switchRow(id, label, hint, checked, onChange) {
      var input = h('input', { type: 'checkbox', id: id, role: 'switch', checked: checked });
      input.addEventListener('change', function () {
        input.disabled = true;
        err.textContent = '';
        Promise.resolve(onChange(input.checked))
          .catch(function (e) { input.checked = !input.checked; err.textContent = friendlyError(e); })
          .then(function () { input.disabled = false; });
      });
      return h('div', { class: 'setting' },
        h('div', { class: 'setting-text' }, h('label', { for: id, text: label }), hint ? h('p', { text: hint }) : null),
        h('div', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' })));
    }

    function drawPrefs(on) {
      if (!on) { prefs.replaceChildren(); return; }
      var time = h('input', { type: 'time', id: 'reminder-time', value: String(settings.reminder_time).slice(0, 5) });
      var days = h('div', { class: 'chips wrap days', role: 'group', 'aria-label': 'Reminder days' },
        DAY_LABELS.map(function (d, i) {
          var b = h('button', { class: 'chip day', type: 'button', 'aria-label': d[1], 'aria-pressed': settings.reminder_days.indexOf(i) >= 0 ? 'true' : 'false' }, d[0]);
          b.addEventListener('click', function () { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); });
          return b;
        }));
      var saveReminder = h('button', { class: 'btn small', type: 'button', text: 'Save reminder' });
      var reminderBox = h('div', { class: 'reminder', hidden: !settings.reminder_enabled },
        h('div', { class: 'field' }, h('label', { for: 'reminder-time', text: 'Time' }), time),
        h('p', { class: 'hint', text: 'Days' }), days,
        h('div', { class: 'row' }, saveReminder));
      saveReminder.addEventListener('click', busy(saveReminder, err, function () {
        var chosen = [];
        days.querySelectorAll('.day').forEach(function (b, i) { if (b.getAttribute('aria-pressed') === 'true') chosen.push(i); });
        if (!time.value) throw new Error('Choose a time for your reminder.');
        if (!chosen.length) throw new Error('Choose at least one day.');
        return saveSettings({ reminder_enabled: true, reminder_time: time.value, reminder_days: chosen })
          .then(function () { toast('Reminder saved.'); });
      }));
      prefs.replaceChildren(
        switchRow('notify-urgent', 'Urgent prayers', 'A push when an urgent request is shared.', settings.urgent,
          function (v) { return saveSettings({ urgent: v }); }),
        switchRow('notify-scheduled', 'Pray-at times', 'A "Pray now" push when a request asks the group to pray at a set time.', settings.scheduled,
          function (v) { return saveSettings({ scheduled: v }); }),
        switchRow('notify-reminder', 'Daily prayer reminder', 'A gentle nudge to spend time in prayer.', settings.reminder_enabled,
          function (v) {
            reminderBox.hidden = !v;
            return saveSettings({ reminder_enabled: v });
          }),
        reminderBox);
    }

    function draw(sub) {
      current = sub || null;
      var on = !!sub && Notification.permission === 'granted';
      if (Notification.permission === 'denied') {
        status.textContent = 'Notifications are blocked for Upheld on this phone. On iPhone, the simplest fix is to delete Upheld from your home screen, add it again from Safari, and sign back in. Then tap Turn on notifications and choose Allow.';
        toggleBtn.hidden = true;
      } else {
        status.textContent = on ? 'On for this phone.' : 'Get a push for urgent prayers, pray-at times, and your own prayer reminder.';
        toggleBtn.hidden = false;
        toggleBtn.textContent = on ? 'Turn off on this phone' : 'Turn on notifications';
        toggleBtn.className = on ? 'btn small secondary' : 'btn small';
      }
      drawPrefs(on);
    }

    // iPhone only allows pushManager.subscribe() while it is still handling the tap, so the
    // registration is fetched ahead of time and subscribe() is called before anything else waits.
    var swReg = null, current = null;
    navigator.serviceWorker.ready.then(function (reg) { swReg = reg; });

    var turnOff = busy(toggleBtn, err, function () {
      var sub = current;
      return sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint).then(must)
        .then(function () { return sub.unsubscribe(); })
        .then(function () { toast('Notifications off for this phone.'); draw(null); });
    });

    toggleBtn.addEventListener('click', function (ev) {
      if (current && Notification.permission === 'granted') return turnOff(ev);
      var pending = swReg
        ? swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey() })
        : Promise.reject(new Error('Upheld is still starting up. Try again in a moment.'));
      pending.catch(function () {});
      busy(toggleBtn, err, function () {
        return pending.catch(function (e) {
          draw(null);
          if (Notification.permission === 'denied') return null; // draw() already explains how to unblock
          throw e && /denied|not allowed/i.test(e.message || '') ? new Error('Notifications weren\'t allowed. Tap "Turn on notifications" again and choose Allow.') : e;
        }).then(function (newSub) {
          if (!newSub) return;
          var j = newSub.toJSON();
          return sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth }).then(must)
            .then(function () { toast('Notifications are on.'); draw(newSub); });
        });
      })(ev);
    });

    status.textContent = 'Checking…';
    Promise.all([
      currentSubscription().catch(function () { return null; }),
      sb.from('notification_settings').select('urgent, scheduled, reminder_enabled, reminder_time, reminder_days')
        .eq('user_id', state.user.id).maybeSingle().then(must).catch(function () { return null; })
    ]).then(function (r) {
      if (r[1]) Object.assign(settings, r[1]);
      draw(r[0]);
    });
    return card;
  }

  // ---------------------------------------------------------------------------
  // Opening Upheld from a notification: ?group=…&prayer=… or ?pray=1
  // ---------------------------------------------------------------------------

  var deepLink = (function () {
    try {
      var q = new URLSearchParams(location.search);
      return { group: q.get('group'), prayer: q.get('prayer'), pray: q.get('pray') === '1' };
    } catch (e) { return {}; }
  })();

  function handleDeepLink() {
    var link = deepLink;
    deepLink = {};
    if (!link.group && !link.prayer && !link.pray) return;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    if (link.group && link.group !== state.groupId) {
      var target = state.groups.filter(function (x) { return x.group_id === link.group && x.status === 'active'; })[0];
      if (!target) return;
      selectGroup(target.group_id);
    }
    var g = currentGroup();
    if (!g || g.status !== 'active') return;
    return loadPrayerData(g).then(function () {
      if (link.prayer) {
        var p = pdata.prayers.filter(function (x) { return x.id === link.prayer; })[0];
        if (p) showPrayer(g, p);
      } else if (link.pray) {
        showPrayerSetup(g);
      }
    }).catch(function () {});
  }

  // Approvers manage the group's prayer lists (the tabs on the Prayers screen).
  function listsCard(g) {
    var err = h('p', { class: 'error', role: 'alert' });
    var ul = h('ul', { class: 'people' }, h('li', { class: 'person' }, h('p', { class: 'empty', text: 'Loading…' })));
    var input = h('input', { type: 'text', id: 'new-list', maxlength: '60', placeholder: 'New list name' });
    var add = h('button', { class: 'btn small', type: 'submit', text: 'Add list' });
    var form = h('form', { class: 'row list-add', novalidate: true },
      h('label', { for: 'new-list', class: 'sr-only', text: 'New list name' }), input, add);
    var lists = [];

    function load() {
      return sb.from('lists').select('id, name, sort_order').eq('group_id', g.group_id)
        .order('sort_order', { ascending: true }).order('name', { ascending: true }).then(must)
        .then(function (rows) { lists = rows || []; draw(); });
    }
    function draw() {
      if (!lists.length) {
        ul.replaceChildren(h('li', { class: 'person' }, h('p', { class: 'empty', text: 'No lists yet. Prayers without a list still show under All.' })));
        return;
      }
      ul.replaceChildren.apply(ul, lists.map(function (l, i) {
        var rename = h('button', { class: 'btn small quiet', type: 'button', text: 'Rename' });
        rename.addEventListener('click', busy(rename, err, function () {
          var name = prompt('Rename "' + l.name + '" to:', l.name);
          if (name == null) return;
          name = name.trim().replace(/\s+/g, ' ');
          if (!name) throw new Error('A list needs a name.');
          return sb.from('lists').update({ name: name }).eq('id', l.id).select().then(mustChange).then(load);
        }));
        var up = i > 0 ? h('button', { class: 'btn small quiet', type: 'button', text: '↑', 'aria-label': 'Move ' + l.name + ' up' }) : null;
        if (up) up.addEventListener('click', busy(up, err, function () {
          // Swap with the list above, then renumber everything 0..n-1 so orders never collide.
          var order = lists.slice();
          order[i] = order[i - 1];
          order[i - 1] = l;
          return Promise.all(order.map(function (x, idx) {
            return x.sort_order === idx ? null
              : sb.from('lists').update({ sort_order: idx }).eq('id', x.id).select().then(mustChange);
          })).then(load);
        }));
        var del = h('button', { class: 'btn small quiet danger-text', type: 'button', text: 'Delete' });
        del.addEventListener('click', busy(del, err, function () {
          if (!confirm('Delete the list "' + l.name + '"? Its prayers stay and still show under All.')) return;
          return sb.from('lists').delete().eq('id', l.id).select().then(mustChange).then(load);
        }));
        return h('li', { class: 'person list-row' },
          h('div', { class: 'person-name', text: l.name }),
          h('div', { class: 'list-actions' }, up, rename, del));
      }));
    }
    form.addEventListener('submit', busy(add, err, function () {
      var name = input.value.trim().replace(/\s+/g, ' ');
      if (!name) throw new Error('Enter a list name.');
      var next = lists.reduce(function (m, l) { return Math.max(m, l.sort_order); }, -1) + 1;
      return sb.from('lists').insert({ group_id: g.group_id, name: name, sort_order: next }).select().then(mustChange)
        .then(function () { input.value = ''; return load(); });
    }));
    load().catch(function (e) { err.textContent = friendlyError(e); });
    return h('section', { class: 'card' },
      h('h2', { text: 'Prayer lists' }),
      h('p', { class: 'hint', text: 'Lists are the tabs on the Prayers screen, like Health or Family.' }),
      ul, form, err);
  }

  // ---------------------------------------------------------------------------
  // Group switcher sheet
  // ---------------------------------------------------------------------------

  var sheetEl = null;
  function closeSheet() {
    if (sheetEl) { sheetEl.remove(); sheetEl = null; document.removeEventListener('keydown', onSheetKey); }
  }
  function onSheetKey(e) { if (e.key === 'Escape') closeSheet(); }
  function openGroupSheet() {
    closeSheet();
    var sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
      h('h2', { id: 'sheet-title', text: 'Your groups' }),
      state.groups.map(function (g) {
        return h('button', { class: 'group-option', type: 'button', onclick: function () { selectGroup(g.group_id); } },
          h('span', { class: 'name', text: g.name }),
          g.status === 'pending' ? h('span', { class: 'person-meta', text: 'Waiting' }) : null,
          g.group_id === state.groupId ? h('span', { class: 'check', text: '✓', 'aria-label': 'current' }) : null);
      }),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn secondary', type: 'button', text: 'Join or start a group', onclick: showStart }),
        h('button', { class: 'btn quiet', type: 'button', text: 'Close', onclick: closeSheet })));
    sheetEl = h('div', { class: 'sheet-backdrop', onclick: function (e) { if (e.target === sheetEl) closeSheet(); } }, sheet);
    document.body.appendChild(sheetEl);
    document.addEventListener('keydown', onSheetKey);
    var first = sheet.querySelector('button');
    if (first) first.focus();
  }

  // ---------------------------------------------------------------------------
  // Start up
  // ---------------------------------------------------------------------------

  function signOut() {
    sb.auth.signOut().catch(function () {}).then(function () {
      state.user = null;
      state.profile = null;
      state.groups = [];
      state.pendingCount = 0;
      showEmail();
    });
  }

  function showFatal(err) {
    render(h('main', { class: 'screen' },
      brand(),
      h('h1', { text: 'Can\'t load Upheld' }),
      h('p', { class: 'lede', text: friendlyError(err) }),
      h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: function () { location.reload(); } })));
  }

  sb.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT' && state.user) {
      state.user = null;
      showEmail('You\'ve been signed out. Sign in again to continue.');
    }
  });

  // Refresh when the app comes back to the foreground (e.g. to pick up an approval).
  document.addEventListener('visibilitychange', function () {
    // Only refresh the main group and pending screens; never interrupt prayer time or a form.
    if (document.visibilityState !== 'visible' || !state.user || sheetEl) return;
    if (state.view !== 'group' && state.view !== 'pending') return;
    if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    loadGroups().then(route).catch(function () {});
  });

  sb.auth.getSession().then(must).then(function (data) {
    if (data.session && data.session.user) return afterSignIn(data.session.user);
    showEmail();
  }).catch(showFatal);
})();
