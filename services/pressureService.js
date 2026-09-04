// Who is carrying too much this month, and what to move.
//
// The question this answers is the one a manager actually asks: "eight VAT
// returns land on Suma this month and two on Neha — is that right?" The
// existing capacity service could not answer it. It counts open tasks per
// LOGIN USER and weights every task the same, so a VAT return and a document
// chase score identically, and the eight-versus-two problem is invisible.
//
// This one counts the work itself — VAT returns due, CT returns due, months
// of books open — for the month you are looking at, against the person the
// CLIENT is assigned to.
//
// Two deliberate choices worth knowing about:
//
//  1. A VAT-registered client with no return rows set up still counts as
//     load. Today 19 clients are VAT-registered and one has rows configured;
//     scoring only the rows would report almost no VAT pressure anywhere,
//     which is worse than useless — it is confidently wrong. Those clients
//     are counted and separately flagged as needing their periods set up.
//  2. Rebalancing moves whole clients, not individual tasks. Splitting one
//     client's VAT across two people is how filings get missed — somebody has
//     to own the client, and that is what assignedTeam means.

var { tracker } = require('../database');
var roles = require('../roles');

// Effort weights. Deliberately few and deliberately visible in the UI: a
// score nobody can explain is a score nobody trusts. A CT return is the
// heaviest single piece of work in a year, a VAT return is a recurring
// multi-day job, a month of books is the unit everything else is measured in.
var WEIGHTS = { ct: 5, vat: 3, books: 1 };

function monthKey(d) {
  var dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
}

function currentMonth() { return monthKey(new Date()); }

function isDone(s) { return String(s || '').toLowerCase() === 'completed'; }

// Months before a client's scope start are not our work.
function beforeScope(client, mk) {
  var s = client && client.scopeStart;
  return !!(s && mk < s);
}

// The work sitting on one client in one month.
function loadForClient(client, mk) {
  var out = { vat: 0, ct: 0, books: 0, vatNeedsSetup: false };
  if (!client || beforeScope(client, mk)) return out;

  // ---- VAT
  var rows = (client.vat && client.vat.returnDates) || [];
  var dueThisMonth = rows.filter(function(r) {
    return r && monthKey(r.dueDate) === mk && !isDone(r.filingStatus);
  });
  if (dueThisMonth.length) {
    out.vat = dueThisMonth.length;
  } else if (client.vatApplicable === 'Yes' && !rows.length) {
    // Registered, but nobody has set the periods up. Real work, invisible to
    // any count based on the rows themselves. Counted as one, and flagged.
    out.vat = 1;
    out.vatNeedsSetup = true;
  }

  // ---- Corporate tax
  if (client.ctApplicable && client.ct && monthKey(client.ct.dueDate) === mk && !isDone(client.ct.status)) {
    out.ct = 1;
  }

  // ---- Books for the month
  var status = (client.accounting && client.accounting.monthlyStatus && client.accounting.monthlyStatus[mk]) || null;
  if (status && status !== 'Completed' && status !== 'Not Applicable') out.books = 1;

  return out;
}

function scoreOf(l) {
  return l.vat * WEIGHTS.vat + l.ct * WEIGHTS.ct + l.books * WEIGHTS.books;
}

// Everyone who can hold clients. Since the team list was folded into real
// logins, that is the active user list — a name with no account cannot be
// assigned work, and anything still sitting on one is reported as unassigned
// rather than quietly counted against nobody.
function assignablePeople(users, viewer) {
  var active = (users || []).filter(function(u) { return u && u.active !== false; });
  if (!viewer || roles.isSuperAdmin(viewer)) return active;
  return active.filter(function(u) {
    return String(u.id) === String(viewer.id) || String(u.reports_to) === String(viewer.id);
  });
}

// The month's picture: what each person carries, how that compares with an
// even split, and which clients are sitting on nobody.
function getPressure(options) {
  var opts = options || {};
  var mk = opts.month || currentMonth();
  var users = opts.users || [];
  var viewer = opts.viewer;
  var clients = (tracker.getData().clients) || [];

  var people = assignablePeople(users, viewer).map(function(u) {
    return {
      id: u.id, name: u.name, email: u.email, role: u.role,
      vat: 0, ct: 0, books: 0, score: 0,
      clients: 0, vatNeedsSetup: 0, clientList: []
    };
  });
  var byName = {};
  people.forEach(function(p) { byName[String(p.name || '').toLowerCase()] = p; });

  var unassigned = { name: 'Unassigned', vat: 0, ct: 0, books: 0, score: 0, clients: 0, vatNeedsSetup: 0, clientList: [] };
  // Clients sitting on a name that has no login. Since only real users can
  // hold work now, these are stranded and need moving — so they are named,
  // not folded into a total.
  var noLoginOwners = {};

  clients.forEach(function(c) {
    var owner = String(c.assignedTeam || '').trim();
    var l = loadForClient(c, mk);
    var s = scoreOf(l);
    var target;

    if (!owner || owner === 'Unassigned') {
      target = unassigned;
    } else {
      target = byName[owner.toLowerCase()];
      if (!target) {
        // Held by somebody without an account.
        if (!noLoginOwners[owner]) noLoginOwners[owner] = { name: owner, clients: 0, score: 0, vat: 0, ct: 0, books: 0 };
        noLoginOwners[owner].clients++;
        noLoginOwners[owner].score += s;
        noLoginOwners[owner].vat += l.vat;
        noLoginOwners[owner].ct += l.ct;
        noLoginOwners[owner].books += l.books;
        return;
      }
    }

    target.vat += l.vat; target.ct += l.ct; target.books += l.books;
    target.score += s; target.clients++;
    if (l.vatNeedsSetup) target.vatNeedsSetup++;
    if (s > 0) target.clientList.push({ id: c.id, name: c.name, vat: l.vat, ct: l.ct, books: l.books, score: s });
  });

  // Heaviest client first — moving one big client beats shuffling five small
  // ones, and the suggestions below rely on this ordering.
  people.forEach(function(p) { p.clientList.sort(function(a, b) { return b.score - a.score; }); });

  var totalScore = people.reduce(function(a, p) { return a + p.score; }, 0);
  var fairShare = people.length ? totalScore / people.length : 0;

  people.forEach(function(p) {
    p.fairShare = Math.round(fairShare * 10) / 10;
    p.ratio = fairShare > 0 ? Math.round((p.score / fairShare) * 100) / 100 : (p.score > 0 ? 99 : 1);
    // Bands are wide on purpose. Real teams are never exactly even, and a tool
    // that shouts "unbalanced" at a 10% difference gets ignored.
    p.band = p.ratio >= 1.3 ? 'over' : (p.ratio <= 0.7 ? 'light' : 'balanced');
  });
  people.sort(function(a, b) { return b.score - a.score; });

  return {
    month: mk,
    weights: WEIGHTS,
    people: people,
    unassigned: unassigned,
    noLoginOwners: Object.keys(noLoginOwners).map(function(k) { return noLoginOwners[k]; })
      .sort(function(a, b) { return b.clients - a.clients; }),
    totals: {
      score: totalScore,
      vat: people.reduce(function(a, p) { return a + p.vat; }, 0) + unassigned.vat,
      ct: people.reduce(function(a, p) { return a + p.ct; }, 0) + unassigned.ct,
      books: people.reduce(function(a, p) { return a + p.books; }, 0) + unassigned.books,
      fairShare: Math.round(fairShare * 10) / 10,
      spread: people.length ? (people[0].score - people[people.length - 1].score) : 0
    }
  };
}

// Suggest whole-client moves that flatten the month.
//
// Greedy and conservative: take the heaviest client off the most loaded
// person, give it to the lightest, stop as soon as the move would not
// actually help. It deliberately will not move a client whose transfer just
// swaps who is overloaded — a suggestion that has to be undone next month is
// worse than no suggestion.
function suggestRebalance(pressure, maxMoves) {
  var limit = maxMoves || 10;
  // Work on copies; nothing here touches stored data.
  var people = pressure.people.map(function(p) {
    return { id: p.id, name: p.name, score: p.score, clientList: p.clientList.slice() };
  });
  if (people.length < 2) return { moves: [], note: 'Needs at least two people with logins to balance across.' };

  var fair = pressure.totals.fairShare;
  var moves = [];

  for (var n = 0; n < limit; n++) {
    people.sort(function(a, b) { return b.score - a.score; });
    var from = people[0], to = people[people.length - 1];
    if (!from || !to || from.id === to.id) break;

    var gap = from.score - to.score;
    // Once the two ends are within about a third of an even split, the team is
    // as level as this kind of shuffling can usefully make it.
    if (gap <= Math.max(3, fair * 0.35)) break;

    // The best client to move is the one that most reduces the gap without
    // overshooting — moving a 20-point client across a 10-point gap just
    // reverses the problem.
    var best = null, bestAfter = gap;
    from.clientList.forEach(function(c) {
      var after = Math.abs((from.score - c.score) - (to.score + c.score));
      if (after < bestAfter) { bestAfter = after; best = c; }
    });
    if (!best) break;

    moves.push({
      clientId: best.id, clientName: best.name,
      fromUserId: from.id, fromName: from.name,
      toUserId: to.id, toName: to.name,
      score: best.score, vat: best.vat, ct: best.ct, books: best.books,
      gapBefore: Math.round(gap * 10) / 10, gapAfter: Math.round(bestAfter * 10) / 10
    });

    from.score -= best.score; to.score += best.score;
    from.clientList = from.clientList.filter(function(c) { return c.id !== best.id; });
    to.clientList.push(best);
  }

  return { moves: moves, note: moves.length ? '' : 'The month is already about as even as whole-client moves can make it.' };
}

module.exports = {
  getPressure: getPressure,
  suggestRebalance: suggestRebalance,
  loadForClient: loadForClient,
  currentMonth: currentMonth,
  monthKey: monthKey,
  WEIGHTS: WEIGHTS
};
