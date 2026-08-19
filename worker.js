const CURRENT_LEAGUE_ID = "1327788752298336256";
const SLEEPER = "https://api.sleeper.app/v1";
const GITHUB_OWNER = "christianhwill";
const GITHUB_REPO = "sleeper-dynasty-league";
const GITHUB_BRANCH = "main";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          service: "Sleeper Dynasty Sync",
          current_league_id: CURRENT_LEAGUE_ID,
          github_repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          github_token_configured: Boolean(env.GITHUB_TOKEN)
        });
      }

      if (!env.GITHUB_TOKEN) {
        return json({ ok: false, error: "GITHUB_TOKEN secret is not configured." }, 500);
      }

      if (url.pathname === "/chain") {
        const chain = await discoverLeagueChain(CURRENT_LEAGUE_ID);
        return json({ ok: true, chain });
      }

      if (url.pathname === "/sync") {
        const result = await syncSeasonToGitHub(CURRENT_LEAGUE_ID, env.GITHUB_TOKEN, true);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/sync-season") {
        const leagueId = url.searchParams.get("league_id");
        if (!leagueId) {
          return json({ ok: false, error: "Missing league_id query parameter." }, 400);
        }
        const result = await syncSeasonToGitHub(leagueId, env.GITHUB_TOKEN, leagueId === CURRENT_LEAGUE_ID);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/bootstrap") {
        const chain = await discoverLeagueChain(CURRENT_LEAGUE_ID);
        await upsertGitHubJSON(
          "config/league-chain.json",
          { generated_at: new Date().toISOString(), chain },
          "Update Sleeper league chain",
          env.GITHUB_TOKEN
        );
        return json({
          ok: true,
          message: "League chain saved to GitHub. Sync each season with /sync-season?league_id=...",
          chain
        });
      }

      return json({
        ok: true,
        service: "Sleeper Dynasty Sync",
        routes: {
          health: "/health",
          discover_history: "/chain",
          save_history_chain: "/bootstrap",
          sync_current_season: "/sync",
          sync_one_season: "/sync-season?league_id=LEAGUE_ID"
        }
      });
    } catch (error) {
      return json({ ok: false, error: error.message, stack: error.stack }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.GITHUB_TOKEN) return;
    ctx.waitUntil(syncSeasonToGitHub(CURRENT_LEAGUE_ID, env.GITHUB_TOKEN, true));
  }
};

async function discoverLeagueChain(startLeagueId) {
  const seen = new Set();
  const chain = [];
  let leagueId = startLeagueId;

  while (leagueId && leagueId !== "0" && !seen.has(leagueId) && chain.length < 10) {
    seen.add(leagueId);
    const league = await getJSON(`${SLEEPER}/league/${leagueId}`);
    chain.push({
      season: String(league.season),
      league_id: String(league.league_id),
      name: league.name || null,
      previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
      status: league.status || null
    });
    leagueId = league.previous_league_id ? String(league.previous_league_id) : null;
  }

  return chain;
}

async function syncSeasonToGitHub(leagueId, githubToken, isCurrent) {
  const players = await getPlayers();

  const [league, users, rosters, tradedPicks, drafts] = await Promise.all([
    getJSON(`${SLEEPER}/league/${leagueId}`),
    getJSON(`${SLEEPER}/league/${leagueId}/users`),
    getJSON(`${SLEEPER}/league/${leagueId}/rosters`),
    getJSON(`${SLEEPER}/league/${leagueId}/traded_picks`),
    getJSON(`${SLEEPER}/league/${leagueId}/drafts`)
  ]);

  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map(r => [String(r.roster_id), r]));

  // Sleeper transaction endpoints are week/round based. Query 0-18 to include
  // preseason/offseason-style buckets plus all regular-season weeks.
  const transactionWeeks = Array.from({ length: 19 }, (_, i) => i);
  const txGroups = await Promise.all(transactionWeeks.map(async week => {
    try {
      const txs = await getJSON(`${SLEEPER}/league/${leagueId}/transactions/${week}`);
      return txs.map(tx => ({ ...tx, sleeper_week: week }));
    } catch {
      return [];
    }
  }));

  const transactionsRaw = dedupeById(txGroups.flat(), "transaction_id")
    .sort((a, b) => (a.created || 0) - (b.created || 0));

  const transactions = transactionsRaw.map(tx =>
    normalizeTransaction(tx, players, rosterById, userById)
  );

  const trades = transactions.filter(tx => tx.type === "trade");

  const draftData = [];
  for (const draft of drafts) {
    let picks = [];
    let draftTradedPicks = [];
    try { picks = await getJSON(`${SLEEPER}/draft/${draft.draft_id}/picks`); } catch {}
    try { draftTradedPicks = await getJSON(`${SLEEPER}/draft/${draft.draft_id}/traded_picks`); } catch {}

    draftData.push({
      draft_id: String(draft.draft_id),
      season: String(draft.season),
      status: draft.status,
      type: draft.type,
      settings: draft.settings || {},
      metadata: draft.metadata || {},
      slot_to_roster_id: draft.slot_to_roster_id || {},
      picks: picks.map(p => ({
        ...p,
        player: playerInfo(p.player_id, players),
        roster_name: teamName(p.roster_id, rosterById, userById)
      })),
      traded_picks: draftTradedPicks.map(p => normalizePick(p, rosterById, userById))
    });
  }

  const teams = rosters.map(roster => {
    const owner = userById[roster.owner_id] || {};
    return {
      roster_id: roster.roster_id,
      owner_id: roster.owner_id,
      username: owner.username || null,
      display_name: owner.display_name || null,
      team_name:
        owner.metadata?.team_name ||
        owner.display_name ||
        owner.username ||
        `Roster ${roster.roster_id}`,
      is_commissioner: Boolean(owner.is_owner),
      settings: roster.settings || {},
      record: {
        wins: roster.settings?.wins ?? 0,
        losses: roster.settings?.losses ?? 0,
        ties: roster.settings?.ties ?? 0,
        points_for:
          Number(roster.settings?.fpts || 0) +
          Number(roster.settings?.fpts_decimal || 0) / 100,
        points_against:
          Number(roster.settings?.fpts_against || 0) +
          Number(roster.settings?.fpts_against_decimal || 0) / 100
      },
      players: (roster.players || []).map(id => playerInfo(id, players)),
      starters: (roster.starters || []).map(id => playerInfo(id, players)),
      taxi: (roster.taxi || []).map(id => playerInfo(id, players)),
      reserve: (roster.reserve || []).map(id => playerInfo(id, players))
    };
  });

  const season = String(league.season);
  const seasonDir = `history/${season}`;
  const generatedAt = new Date().toISOString();

  const leagueSummary = {
    generated_at: generatedAt,
    league: {
      league_id: String(league.league_id),
      previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
      name: league.name,
      season,
      status: league.status,
      total_rosters: league.total_rosters,
      settings: league.settings,
      scoring_settings: league.scoring_settings,
      roster_positions: league.roster_positions,
      draft_id: league.draft_id ? String(league.draft_id) : null
    }
  };

  const files = [
    [`${seasonDir}/league.json`, leagueSummary],
    [`${seasonDir}/teams.json`, { generated_at: generatedAt, season, teams }],
    [`${seasonDir}/transactions.json`, { generated_at: generatedAt, season, transactions }],
    [`${seasonDir}/trades.json`, { generated_at: generatedAt, season, trades }],
    [`${seasonDir}/traded-picks.json`, {
      generated_at: generatedAt,
      season,
      traded_picks: tradedPicks.map(p => normalizePick(p, rosterById, userById))
    }],
    [`${seasonDir}/drafts.json`, { generated_at: generatedAt, season, drafts: draftData }]
  ];

  // Write serially to avoid GitHub contents API conflicts.
  for (const [path, data] of files) {
    await upsertGitHubJSON(path, data, `Sync Sleeper ${season}: ${path.split("/").pop()}`, githubToken);
  }

  if (isCurrent) {
    await upsertGitHubJSON(
      "current.json",
      {
        generated_at: generatedAt,
        season,
        league: leagueSummary.league,
        teams,
        traded_picks: tradedPicks.map(p => normalizePick(p, rosterById, userById)),
        recent_transactions: transactions.slice(-100).reverse()
      },
      `Update live Sleeper snapshot (${season})`,
      githubToken
    );
  }

  return {
    season,
    league_id: String(league.league_id),
    previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
    files_written: files.map(([path]) => path).concat(isCurrent ? ["current.json"] : []),
    transaction_count: transactions.length,
    trade_count: trades.length,
    draft_count: draftData.length,
    team_count: teams.length
  };
}

function normalizeTransaction(tx, players, rosterById, userById) {
  return {
    transaction_id: String(tx.transaction_id),
    type: tx.type,
    status: tx.status,
    created: tx.created,
    created_iso: tx.created ? new Date(tx.created).toISOString() : null,
    week: tx.sleeper_week,
    leg: tx.leg ?? null,
    creator: tx.creator || null,
    roster_ids: tx.roster_ids || [],
    teams: (tx.roster_ids || []).map(id => ({
      roster_id: id,
      team_name: teamName(id, rosterById, userById)
    })),
    adds: mapPlayerMoves(tx.adds, players, rosterById, userById),
    drops: mapPlayerMoves(tx.drops, players, rosterById, userById),
    draft_picks: (tx.draft_picks || []).map(p => normalizePick(p, rosterById, userById)),
    waiver_budget: tx.waiver_budget || [],
    waiver_bid: tx.settings?.waiver_bid ?? null,
    metadata: tx.metadata || null
  };
}

function normalizePick(p, rosterById, userById) {
  return {
    season: String(p.season),
    round: p.round,
    original_roster_id: p.roster_id,
    previous_owner_roster_id: p.previous_owner_id,
    current_owner_roster_id: p.owner_id,
    original_team: teamName(p.roster_id, rosterById, userById),
    previous_team: teamName(p.previous_owner_id, rosterById, userById),
    current_team: teamName(p.owner_id, rosterById, userById)
  };
}

async function getPlayers() {
  const cache = caches.default;
  const key = new Request("https://sleeper-dynasty-sync.internal/players");
  let response = await cache.match(key);

  if (!response) {
    const upstream = await fetch(`${SLEEPER}/players/nfl`, {
      headers: { "User-Agent": "SleeperDynastySync/2.0" }
    });
    if (!upstream.ok) {
      throw new Error(`${upstream.status} fetching Sleeper player database`);
    }
    response = new Response(upstream.body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400"
      }
    });
    await cache.put(key, response.clone());
  }

  return response.json();
}

async function getJSON(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "SleeperDynastySync/2.0"
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${url}`);
  }
  return response.json();
}

async function upsertGitHubJSON(path, data, message, token) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`;
  let sha = null;

  const existing = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: githubHeaders(token)
  });

  if (existing.ok) {
    const existingData = await existing.json();
    sha = existingData.sha || null;
  } else if (existing.status !== 404) {
    const text = await existing.text();
    throw new Error(`GitHub read failed for ${path}: ${existing.status} ${text}`);
  }

  const body = {
    message,
    content: utf8ToBase64(JSON.stringify(data, null, 2)),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;

  const write = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!write.ok) {
    const text = await write.text();
    throw new Error(`GitHub write failed for ${path}: ${write.status} ${text}`);
  }

  return write.json();
}

function githubHeaders(token) {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "SleeperDynastySync/2.0"
  };
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function dedupeById(items, key) {
  const seen = new Set();
  return items.filter(item => {
    const id = item?.[key];
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function playerInfo(id, players) {
  if (!id) return null;
  const p = players[id];
  if (!p) {
    return {
      player_id: id,
      name: id,
      position: String(id).length <= 4 ? "DEF" : null,
      team: String(id).length <= 4 ? id : null
    };
  }
  return {
    player_id: id,
    name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id,
    first_name: p.first_name || null,
    last_name: p.last_name || null,
    position: p.position || null,
    fantasy_positions: p.fantasy_positions || [],
    team: p.team || null,
    status: p.status || null,
    injury_status: p.injury_status || null,
    age: p.age || null,
    years_exp: p.years_exp || null
  };
}

function teamName(rosterId, rosterById, userById) {
  if (rosterId === null || rosterId === undefined) return null;
  const roster = rosterById[String(rosterId)];
  if (!roster) return `Roster ${rosterId}`;
  const user = userById[roster.owner_id] || {};
  return user.metadata?.team_name || user.display_name || user.username || `Roster ${rosterId}`;
}

function mapPlayerMoves(moves, players, rosterById, userById) {
  if (!moves) return [];
  return Object.entries(moves).map(([playerId, rosterId]) => ({
    player: playerInfo(playerId, players),
    roster_id: rosterId,
    team_name: teamName(rosterId, rosterById, userById)
  }));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    }
  });
}
