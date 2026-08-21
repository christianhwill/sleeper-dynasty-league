const ARCHETYPE_LABELS = Object.freeze({
  deal_maker: {
    label: "The Deal Maker",
    description: "Builds through trades and is consistently willing to reshape the roster."
  },
  waiver_hawk: {
    label: "The Waiver Hawk",
    description: "Creates edges through waivers, free agency, and persistent roster churn."
  },
  future_builder: {
    label: "The Future Builder",
    description: "Emphasizes youth and future draft capital over short-term certainty."
  },
  win_now: {
    label: "The Win-Now Contender",
    description: "Pairs a strong current roster with an aggressive competitive posture."
  },
  balanced: {
    label: "The Balanced Operator",
    description: "Uses a diversified approach without relying on one dominant management style."
  }
});

export function buildLeagueIntelligencePayload({
  generatedAt,
  activeLeagueId,
  gameHistoryDoc,
  playoffHistoryDoc,
  ownerTendenciesDoc,
  currentDoc,
  playerValuesDoc,
  powerRankingsDoc
}) {
  const completedGames = (gameHistoryDoc?.games || [])
    .filter(isCompletedGame)
    .sort(compareGames);
  const directory = buildOwnerDirectory(ownerTendenciesDoc, currentDoc);
  const weeklyContexts = buildWeeklyContexts(completedGames, directory);
  const luck = buildAllPlayAndLuck(weeklyContexts, directory);
  const champions = buildChampionshipHistory(playoffHistoryDoc, directory);
  const leagueRecords = buildLeagueRecords(completedGames, weeklyContexts, directory);
  const rivalries = buildRivalries(completedGames, directory);
  const franchises = buildFranchiseHistory({
    completedGames,
    directory,
    careerLuck: luck.career,
    champions,
    playerValuesDoc,
    powerRankingsDoc
  });
  const archetypes = buildOwnerArchetypes({
    ownerTendenciesDoc,
    directory,
    powerRankingsDoc
  });
  const seasonSummaries = buildSeasonSummaries({
    gameHistoryDoc,
    completedGames,
    weeklyContexts,
    bySeasonLuck: luck.by_season,
    champions,
    directory
  });
  const awards = buildAwards({
    weeklyContexts,
    leagueRecords,
    rivalries,
    seasonSummaries
  });
  const regularGames = completedGames.filter(game => game.phase === "regular");
  const postseasonGames = completedGames.filter(game => game.phase !== "regular");
  const excludedFutureGames = (gameHistoryDoc?.games || []).length - completedGames.length;

  return {
    generated_at: generatedAt,
    intelligence_version: "1.0",
    league: {
      league_id: String(currentDoc?.league?.league_id || activeLeagueId),
      name: currentDoc?.league?.name || ownerTendenciesDoc?.league_name || null,
      active_season: String(currentDoc?.season || currentDoc?.league?.season || ""),
      team_count: Number(currentDoc?.league?.total_rosters || currentDoc?.teams?.length || 0)
    },
    coverage: {
      seasons: (gameHistoryDoc?.seasons || []).map(row => String(row.season)),
      stored_game_count: Number(gameHistoryDoc?.game_count || gameHistoryDoc?.games?.length || 0),
      completed_game_count: completedGames.length,
      completed_regular_season_games: regularGames.length,
      completed_postseason_games: postseasonGames.length,
      completed_regular_season_weeks: new Set(
        regularGames.map(game => `${game.season}:${game.week}`)
      ).size,
      excluded_future_or_incomplete_matchups: excludedFutureGames,
      owners_analyzed: directory.owners.size,
      transaction_participations_analyzed: Number(
        ownerTendenciesDoc?.owners?.reduce(
          (total, owner) => total + Number(owner.activity?.transactions_involved || 0),
          0
        ) || 0
      ),
      future_matchups_excluded_from_historical_metrics: true
    },
    methodology: {
      identity: "Historical roster IDs are mapped to stable owner IDs using owner-tendencies rosters_by_season, so team-name changes do not split a franchise.",
      completed_games: "Only games explicitly marked is_completed=true with two numeric team scores are included. Future placeholders are excluded.",
      all_play: "Each team is compared with every other team score from the same completed regular-season week.",
      expected_wins: "Weekly expected wins equal (all-play wins + 0.5 × all-play ties) divided by the number of possible opponents.",
      luck: "Luck wins equal actual win-equivalents minus expected wins. Positive is fortunate; negative is unfortunate.",
      schedule_strength: "Average points scored by a team's actual regular-season opponents; rank 1 is the toughest schedule.",
      rivalry_score: "Up to 40 points for meetings, 25 for series balance, 25 for close average margins, and 10 for postseason meetings.",
      archetypes: "Deterministic percentile scores combine transactions, trades, waivers/free agency, draft-pick flow, roster age, and current power ranking. Labels are descriptive, not value judgments."
    },
    league_records: leagueRecords,
    franchise_history: franchises,
    all_play_and_luck: luck,
    rivalries: {
      rivalry_count: rivalries.length,
      top_rivalries: rivalries.slice(0, 10),
      all_rivalries: rivalries
    },
    owner_archetypes: archetypes,
    season_summaries: seasonSummaries,
    awards
  };
}

function buildOwnerDirectory(ownerTendenciesDoc, currentDoc) {
  const owners = new Map();
  const bySeasonRoster = new Map();
  const byOwnerId = new Map();

  for (const owner of (ownerTendenciesDoc?.owners || [])) {
    const ownerKey = owner.owner_key || (owner.owner_id ? `user:${owner.owner_id}` : null);
    if (!ownerKey) continue;
    const identity = {
      owner_key: ownerKey,
      owner_id: owner.owner_id || null,
      display_name: owner.display_name || owner.username || owner.current_team_name || ownerKey,
      current_roster_id: finiteNumber(owner.current_roster_id),
      current_team_name: owner.current_team_name || owner.display_name || ownerKey,
      team_names_used: Array.isArray(owner.team_names_used) ? owner.team_names_used : [],
      seasons_active: Array.isArray(owner.seasons_active) ? owner.seasons_active.map(String) : []
    };
    owners.set(ownerKey, identity);
    if (identity.owner_id) byOwnerId.set(String(identity.owner_id), identity);
    for (const [season, rosterId] of Object.entries(owner.rosters_by_season || {})) {
      if (Number.isFinite(Number(rosterId))) {
        bySeasonRoster.set(`${season}:${Number(rosterId)}`, identity);
      }
    }
  }

  const currentSeason = String(currentDoc?.season || currentDoc?.league?.season || "");
  for (const team of (currentDoc?.teams || [])) {
    const ownerId = team.owner_id == null ? null : String(team.owner_id);
    let identity = ownerId ? byOwnerId.get(ownerId) : null;
    if (!identity) {
      const ownerKey = ownerId ? `user:${ownerId}` : `season:${currentSeason}:roster:${team.roster_id}`;
      identity = {
        owner_key: ownerKey,
        owner_id: ownerId,
        display_name: team.display_name || team.username || team.team_name || ownerKey,
        current_roster_id: Number(team.roster_id),
        current_team_name: team.team_name || team.display_name || ownerKey,
        team_names_used: [team.team_name].filter(Boolean),
        seasons_active: [currentSeason].filter(Boolean)
      };
      owners.set(ownerKey, identity);
      if (ownerId) byOwnerId.set(ownerId, identity);
    }
    if (currentSeason) bySeasonRoster.set(`${currentSeason}:${Number(team.roster_id)}`, identity);
  }

  return { owners, bySeasonRoster };
}

function ownerForSide(directory, season, side) {
  const rosterId = Number(side?.roster_id);
  const historicalTeamName = side?.team_name || `Roster ${rosterId}`;
  const existing = directory.bySeasonRoster.get(`${season}:${rosterId}`);
  if (existing) {
    return {
      ...existing,
      roster_id: rosterId,
      historical_team_name: historicalTeamName
    };
  }
  const ownerKey = `season:${season}:roster:${rosterId}`;
  if (!directory.owners.has(ownerKey)) {
    directory.owners.set(ownerKey, {
      owner_key: ownerKey,
      owner_id: null,
      display_name: historicalTeamName,
      current_roster_id: rosterId,
      current_team_name: historicalTeamName,
      team_names_used: [historicalTeamName],
      seasons_active: [String(season)]
    });
  }
  return {
    ...directory.owners.get(ownerKey),
    roster_id: rosterId,
    historical_team_name: historicalTeamName
  };
}

function buildWeeklyContexts(completedGames, directory) {
  const contexts = new Map();
  for (const game of completedGames) {
    const key = `${game.season}:${game.week}:${game.phase || "regular"}`;
    if (!contexts.has(key)) {
      contexts.set(key, {
        key,
        season: String(game.season),
        week: Number(game.week),
        phase: game.phase || "regular",
        games: [],
        teams: []
      });
    }
    const context = contexts.get(key);
    const first = teamPerformance(game, game.team_1, game.team_2, directory);
    const second = teamPerformance(game, game.team_2, game.team_1, directory);
    context.games.push({ game, first, second });
    context.teams.push(first, second);
  }
  return [...contexts.values()].sort((a, b) =>
    Number(a.season) - Number(b.season) || a.week - b.week || String(a.phase).localeCompare(String(b.phase))
  );
}

function teamPerformance(game, side, opponent, directory) {
  const identity = ownerForSide(directory, String(game.season), side);
  const points = Number(side?.points);
  const opponentPoints = Number(opponent?.points);
  const result = points > opponentPoints ? "win" : (points < opponentPoints ? "loss" : "tie");
  return {
    season: String(game.season),
    week: Number(game.week),
    phase: game.phase || "regular",
    matchup_id: game.matchup_id ?? null,
    owner_key: identity.owner_key,
    owner_id: identity.owner_id,
    display_name: identity.display_name,
    current_team_name: identity.current_team_name,
    historical_team_name: identity.historical_team_name,
    roster_id: Number(side.roster_id),
    opponent_owner_key: ownerForSide(directory, String(game.season), opponent).owner_key,
    opponent_team_name: opponent?.team_name || null,
    points,
    opponent_points: opponentPoints,
    result
  };
}

function buildAllPlayAndLuck(weeklyContexts, directory) {
  const bySeasonOwner = new Map();
  for (const context of weeklyContexts.filter(row => row.phase === "regular")) {
    const teamCount = context.teams.length;
    if (teamCount < 2) continue;
    for (const team of context.teams) {
      const key = `${context.season}:${team.owner_key}`;
      if (!bySeasonOwner.has(key)) {
        bySeasonOwner.set(key, makeLuckAccumulator(context.season, team, directory));
      }
      const row = bySeasonOwner.get(key);
      const comparisons = compareAgainstField(team, context.teams);
      row.weeks += 1;
      row.actual_wins += team.result === "win" ? 1 : 0;
      row.actual_losses += team.result === "loss" ? 1 : 0;
      row.actual_ties += team.result === "tie" ? 1 : 0;
      row.actual_win_equivalents += team.result === "win" ? 1 : (team.result === "tie" ? 0.5 : 0);
      row.all_play_wins += comparisons.wins;
      row.all_play_losses += comparisons.losses;
      row.all_play_ties += comparisons.ties;
      row.expected_wins += comparisons.possible
        ? (comparisons.wins + 0.5 * comparisons.ties) / comparisons.possible
        : 0;
      row.points_for += team.points;
      row.points_against += team.opponent_points;
      row.opponent_points_sum += team.opponent_points;
      row.weekly.push({
        week: context.week,
        points: round2(team.points),
        opponent_points: round2(team.opponent_points),
        actual_result: team.result,
        all_play_wins: comparisons.wins,
        all_play_losses: comparisons.losses,
        all_play_ties: comparisons.ties,
        expected_wins: round3(
          comparisons.possible
            ? (comparisons.wins + 0.5 * comparisons.ties) / comparisons.possible
            : 0
        )
      });
    }
  }

  const bySeason = [...bySeasonOwner.values()].map(finalizeLuckRow);
  addRanks(bySeason, row => `${row.season}:${row.owner_key}`, [
    ["all_play_rank", row => row.all_play_win_pct, true],
    ["luck_rank", row => row.luck_wins, true],
    ["unluckiest_rank", row => row.luck_wins, false],
    ["schedule_strength_rank", row => row.average_opponent_points, true]
  ], row => row.season);
  bySeason.sort((a, b) => Number(a.season) - Number(b.season) || a.all_play_rank - b.all_play_rank);

  const careerMap = new Map();
  for (const seasonRow of bySeason) {
    if (!careerMap.has(seasonRow.owner_key)) {
      careerMap.set(seasonRow.owner_key, {
        ...ownerOutput(directory.owners.get(seasonRow.owner_key)),
        seasons: [],
        weeks: 0,
        actual_wins: 0,
        actual_losses: 0,
        actual_ties: 0,
        actual_win_equivalents: 0,
        all_play_wins: 0,
        all_play_losses: 0,
        all_play_ties: 0,
        expected_wins: 0,
        points_for: 0,
        points_against: 0,
        opponent_points_sum: 0
      });
    }
    const career = careerMap.get(seasonRow.owner_key);
    career.seasons.push(seasonRow.season);
    for (const field of [
      "weeks", "actual_wins", "actual_losses", "actual_ties", "actual_win_equivalents",
      "all_play_wins", "all_play_losses", "all_play_ties", "expected_wins",
      "points_for", "points_against", "opponent_points_sum"
    ]) {
      career[field] += Number(seasonRow[field] || 0);
    }
  }
  const career = [...careerMap.values()].map(finalizeLuckRow);
  addRanks(career, row => row.owner_key, [
    ["all_play_rank", row => row.all_play_win_pct, true],
    ["luck_rank", row => row.luck_wins, true],
    ["unluckiest_rank", row => row.luck_wins, false],
    ["schedule_strength_rank", row => row.average_opponent_points, true]
  ]);
  career.sort((a, b) => a.all_play_rank - b.all_play_rank || String(a.current_team_name).localeCompare(String(b.current_team_name)));

  return {
    methodology: {
      scope: "Completed regular-season weeks only.",
      actual_win_equivalent: "One for a win, one-half for a tie, and zero for a loss.",
      expected_wins: "All-play win percentage converted to one expected win per week.",
      luck_wins: "Actual win-equivalents minus expected wins.",
      schedule_strength_rank: "Rank 1 faced the highest average opponent score."
    },
    by_season: bySeason,
    career
  };
}

function makeLuckAccumulator(season, team, directory) {
  const identity = directory.owners.get(team.owner_key);
  return {
    season: String(season),
    ...ownerOutput(identity),
    weeks: 0,
    actual_wins: 0,
    actual_losses: 0,
    actual_ties: 0,
    actual_win_equivalents: 0,
    all_play_wins: 0,
    all_play_losses: 0,
    all_play_ties: 0,
    expected_wins: 0,
    points_for: 0,
    points_against: 0,
    opponent_points_sum: 0,
    weekly: []
  };
}

function finalizeLuckRow(row) {
  const allPlayGames = row.all_play_wins + row.all_play_losses + row.all_play_ties;
  return {
    ...row,
    seasons: row.seasons ? [...new Set(row.seasons)].sort() : undefined,
    actual_win_equivalents: round3(row.actual_win_equivalents),
    expected_wins: round3(row.expected_wins),
    luck_wins: round3(row.actual_win_equivalents - row.expected_wins),
    all_play_win_pct: allPlayGames
      ? round3((row.all_play_wins + 0.5 * row.all_play_ties) / allPlayGames)
      : 0,
    points_for: round2(row.points_for),
    points_against: round2(row.points_against),
    points_per_week: row.weeks ? round2(row.points_for / row.weeks) : 0,
    average_opponent_points: row.weeks ? round2(row.opponent_points_sum / row.weeks) : 0,
    opponent_points_sum: round2(row.opponent_points_sum)
  };
}

function buildLeagueRecords(completedGames, weeklyContexts, directory) {
  const performances = [];
  const gameRows = [];
  const starters = [];
  const bench = [];

  for (const game of completedGames) {
    const first = teamPerformance(game, game.team_1, game.team_2, directory);
    const second = teamPerformance(game, game.team_2, game.team_1, directory);
    performances.push(first, second);
    gameRows.push({
      season: String(game.season),
      week: Number(game.week),
      phase: game.phase || "regular",
      matchup_id: game.matchup_id ?? null,
      team_1: compactPerformance(first),
      team_2: compactPerformance(second),
      combined_points: round2(first.points + second.points),
      margin: round2(Math.abs(first.points - second.points))
    });
    collectPlayerPerformances(starters, bench, game, game.team_1, game.team_2, directory);
    collectPlayerPerformances(starters, bench, game, game.team_2, game.team_1, directory);
  }

  const wins = performances.filter(row => row.result === "win");
  const losses = performances.filter(row => row.result === "loss");
  const weeklyFortune = buildWeeklyFortuneRecords(weeklyContexts);
  const streaks = buildStreakRecords(completedGames, directory);

  return {
    team_game_records: {
      highest_score: compactPerformance(maxBy(performances, row => row.points)),
      lowest_score: compactPerformance(minBy(performances, row => row.points)),
      highest_scoring_loss: compactPerformance(maxBy(losses, row => row.points)),
      lowest_scoring_win: compactPerformance(minBy(wins, row => row.points))
    },
    matchup_records: {
      highest_combined_score: maxBy(gameRows, row => row.combined_points),
      lowest_combined_score: minBy(gameRows, row => row.combined_points),
      largest_margin: maxBy(gameRows, row => row.margin),
      closest_non_tie: minBy(gameRows.filter(row => row.margin > 0), row => row.margin)
    },
    player_records: {
      highest_starter_score: compactPlayerPerformance(maxBy(starters, row => row.fantasy_points)),
      highest_bench_score: compactPlayerPerformance(maxBy(bench, row => row.fantasy_points))
    },
    fortune_records: weeklyFortune,
    streak_records: streaks
  };
}

function collectPlayerPerformances(starters, bench, game, side, opponent, directory) {
  const identity = ownerForSide(directory, String(game.season), side);
  const base = {
    season: String(game.season),
    week: Number(game.week),
    phase: game.phase || "regular",
    owner_key: identity.owner_key,
    current_team_name: identity.current_team_name,
    historical_team_name: identity.historical_team_name,
    opponent_team_name: opponent?.team_name || null
  };
  for (const player of (side?.starters || [])) {
    const points = finiteNumber(player?.fantasy_points);
    if (points === null) continue;
    starters.push({
      ...base,
      player_id: player.player_id || null,
      player_name: player.name || player.player_id || null,
      position: player.position || null,
      fantasy_points: points
    });
  }
  for (const player of (side?.players || [])) {
    if (player?.started) continue;
    const points = finiteNumber(player?.fantasy_points);
    if (points === null) continue;
    bench.push({
      ...base,
      player_id: player.player_id || null,
      player_name: player.name || player.player_id || null,
      position: player.position || null,
      fantasy_points: points
    });
  }
}

function buildWeeklyFortuneRecords(weeklyContexts) {
  const badBeats = [];
  const escapes = [];
  for (const context of weeklyContexts) {
    for (const team of context.teams) {
      const comparisons = compareAgainstField(team, context.teams);
      const row = {
        ...compactPerformance(team),
        all_play_wins_that_week: comparisons.wins,
        all_play_losses_that_week: comparisons.losses,
        field_size: comparisons.possible + 1
      };
      if (team.result === "loss") badBeats.push(row);
      if (team.result === "win") escapes.push(row);
    }
  }
  return {
    worst_bad_beat: maxBy(badBeats, row => row.all_play_wins_that_week * 1000 + row.points),
    luckiest_win: maxBy(escapes, row => row.all_play_losses_that_week * 1000 - row.points)
  };
}

function buildStreakRecords(completedGames, directory) {
  const states = new Map();
  let bestWin = null;
  let bestLoss = null;
  for (const game of completedGames) {
    for (const [side, opponent] of [[game.team_1, game.team_2], [game.team_2, game.team_1]]) {
      const performance = teamPerformance(game, side, opponent, directory);
      if (!states.has(performance.owner_key)) {
        states.set(performance.owner_key, {
          wins: 0,
          losses: 0,
          win_start: null,
          loss_start: null
        });
      }
      const state = states.get(performance.owner_key);
      const marker = { season: performance.season, week: performance.week };
      if (performance.result === "win") {
        state.wins += 1;
        state.win_start = state.win_start || marker;
        state.losses = 0;
        state.loss_start = null;
        if (!bestWin || state.wins > bestWin.games) {
          bestWin = {
            ...compactOwner(performance),
            games: state.wins,
            started: state.win_start,
            ended: marker
          };
        }
      } else if (performance.result === "loss") {
        state.losses += 1;
        state.loss_start = state.loss_start || marker;
        state.wins = 0;
        state.win_start = null;
        if (!bestLoss || state.losses > bestLoss.games) {
          bestLoss = {
            ...compactOwner(performance),
            games: state.losses,
            started: state.loss_start,
            ended: marker
          };
        }
      } else {
        state.wins = 0;
        state.losses = 0;
        state.win_start = null;
        state.loss_start = null;
      }
    }
  }
  return { longest_winning_streak: bestWin, longest_losing_streak: bestLoss };
}

function buildRivalries(completedGames, directory) {
  const pairs = new Map();
  for (const game of completedGames) {
    const first = teamPerformance(game, game.team_1, game.team_2, directory);
    const second = teamPerformance(game, game.team_2, game.team_1, directory);
    if (first.owner_key === second.owner_key) continue;
    const ordered = [first, second].sort((a, b) => String(a.owner_key).localeCompare(String(b.owner_key)));
    const one = ordered[0];
    const two = ordered[1];
    const key = `${one.owner_key}__${two.owner_key}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        rivalry_id: key,
        owner_1: compactOwner(one),
        owner_2: compactOwner(two),
        games: 0,
        wins_1: 0,
        wins_2: 0,
        ties: 0,
        points_1: 0,
        points_2: 0,
        total_margin: 0,
        postseason_meetings: 0,
        one_score_games: 0,
        meetings: []
      });
    }
    const pair = pairs.get(key);
    const margin = Math.abs(one.points - two.points);
    pair.games += 1;
    pair.points_1 += one.points;
    pair.points_2 += two.points;
    pair.total_margin += margin;
    if (one.points > two.points) pair.wins_1 += 1;
    else if (two.points > one.points) pair.wins_2 += 1;
    else pair.ties += 1;
    if (game.phase !== "regular") pair.postseason_meetings += 1;
    if (margin <= 10) pair.one_score_games += 1;
    pair.meetings.push({
      season: String(game.season),
      week: Number(game.week),
      phase: game.phase || "regular",
      team_1_name_at_time: one.historical_team_name,
      team_2_name_at_time: two.historical_team_name,
      points_1: round2(one.points),
      points_2: round2(two.points),
      winner_owner_key: one.points === two.points ? null : (one.points > two.points ? one.owner_key : two.owner_key),
      margin: round2(margin)
    });
  }

  return [...pairs.values()].map(pair => {
    const averageMargin = pair.games ? pair.total_margin / pair.games : 0;
    const decisiveGames = pair.wins_1 + pair.wins_2;
    const balance = decisiveGames
      ? 1 - Math.abs(pair.wins_1 - pair.wins_2) / decisiveGames
      : 1;
    const rivalryScore = Math.min(40, pair.games * 5) +
      25 * balance +
      25 * Math.max(0, 1 - averageMargin / 40) +
      Math.min(10, pair.postseason_meetings * 5);
    const closest = minBy(pair.meetings, row => row.margin);
    const biggest = maxBy(pair.meetings, row => row.margin);
    const leader = pair.wins_1 === pair.wins_2
      ? null
      : (pair.wins_1 > pair.wins_2 ? pair.owner_1 : pair.owner_2);
    return {
      rivalry_id: pair.rivalry_id,
      owner_1: pair.owner_1,
      owner_2: pair.owner_2,
      games: pair.games,
      wins_1: pair.wins_1,
      wins_2: pair.wins_2,
      ties: pair.ties,
      points_1: round2(pair.points_1),
      points_2: round2(pair.points_2),
      average_margin: round2(averageMargin),
      postseason_meetings: pair.postseason_meetings,
      one_score_games: pair.one_score_games,
      series_leader: leader,
      rivalry_type: rivalryType(pair, balance),
      rivalry_score: round2(rivalryScore),
      closest_meeting: closest,
      biggest_blowout: biggest,
      meetings: pair.meetings
    };
  }).sort((a, b) =>
    b.rivalry_score - a.rivalry_score ||
    b.games - a.games ||
    String(a.rivalry_id).localeCompare(String(b.rivalry_id))
  ).map((row, index) => ({ ...row, rivalry_rank: index + 1 }));
}

function rivalryType(pair, balance) {
  if (pair.postseason_meetings >= 2) return "Playoff Blood Feud";
  if (pair.games >= 4 && balance >= 0.75) return "Dead-Even Rivalry";
  if (pair.games >= 4 && Math.max(pair.wins_1, pair.wins_2) / pair.games >= 0.75) return "One-Sided Feud";
  if (pair.games < 4) return "Emerging Rivalry";
  return "Classic Rivalry";
}

function buildChampionshipHistory(playoffHistoryDoc, directory) {
  const rows = [];
  for (const seasonDoc of (playoffHistoryDoc?.seasons || [])) {
    const final = (seasonDoc.winners_bracket || []).find(match => Number(match.placement) === 1);
    const winnerRosterId = finiteNumber(final?.winner_roster_id);
    const loserRosterId = finiteNumber(final?.loser_roster_id);
    if (!final || winnerRosterId === null || winnerRosterId <= 0) continue;
    const winnerIdentity = ownerForSide(directory, String(seasonDoc.season), {
      roster_id: winnerRosterId,
      team_name: final.winner_team
    });
    const loserIdentity = loserRosterId !== null && loserRosterId > 0
      ? ownerForSide(directory, String(seasonDoc.season), {
        roster_id: loserRosterId,
        team_name: final.loser_team
      })
      : null;
    rows.push({
      season: String(seasonDoc.season),
      champion: compactOwner(winnerIdentity),
      champion_team_name_at_time: final.winner_team || winnerIdentity.historical_team_name,
      runner_up: compactOwner(loserIdentity),
      runner_up_team_name_at_time: final.loser_team || loserIdentity?.historical_team_name || null
    });
  }
  return rows.sort((a, b) => Number(a.season) - Number(b.season));
}

function buildFranchiseHistory({
  completedGames,
  directory,
  careerLuck,
  champions,
  playerValuesDoc,
  powerRankingsDoc
}) {
  const rows = new Map();
  const ensure = ownerKey => {
    if (!rows.has(ownerKey)) {
      const identity = directory.owners.get(ownerKey);
      rows.set(ownerKey, {
        ...ownerOutput(identity),
        seasons_active: identity?.seasons_active || [],
        team_names_used: identity?.team_names_used || [],
        regular_season: emptyRecord(),
        postseason: emptyRecord(),
        overall: emptyRecord(),
        championships: 0,
        championship_seasons: []
      });
    }
    return rows.get(ownerKey);
  };

  for (const game of completedGames) {
    for (const [side, opponent] of [[game.team_1, game.team_2], [game.team_2, game.team_1]]) {
      const performance = teamPerformance(game, side, opponent, directory);
      const franchise = ensure(performance.owner_key);
      updateRecord(franchise.overall, performance);
      updateRecord(game.phase === "regular" ? franchise.regular_season : franchise.postseason, performance);
    }
  }
  for (const champion of champions) {
    const franchise = ensure(champion.champion.owner_key);
    franchise.championships += 1;
    franchise.championship_seasons.push(champion.season);
  }

  const luckByOwner = new Map((careerLuck || []).map(row => [row.owner_key, row]));
  const powerByOwner = new Map((powerRankingsDoc?.rankings || []).map(row => [String(row.owner_id), row]));
  const valueByRoster = new Map((playerValuesDoc?.teams || []).map(row => [Number(row.roster_id), row]));
  const output = [...rows.values()].map(row => {
    const identity = directory.owners.get(row.owner_key);
    const luck = luckByOwner.get(row.owner_key) || null;
    const power = identity?.owner_id ? powerByOwner.get(String(identity.owner_id)) : null;
    const value = valueByRoster.get(Number(identity?.current_roster_id)) || null;
    return {
      ...row,
      regular_season: finalizeRecord(row.regular_season),
      postseason: finalizeRecord(row.postseason),
      overall: finalizeRecord(row.overall),
      all_play: luck ? {
        wins: luck.all_play_wins,
        losses: luck.all_play_losses,
        ties: luck.all_play_ties,
        win_pct: luck.all_play_win_pct,
        expected_wins: luck.expected_wins,
        luck_wins: luck.luck_wins,
        rank: luck.all_play_rank
      } : null,
      current_power: power ? {
        rank: power.rank,
        power_score: power.power_score,
        roster_value_score: power.roster_value_score,
        competitive_score: power.competitive_score,
        draft_capital_score: power.draft_capital_score
      } : null,
      current_roster_value: value ? {
        rank: value.roster_value_rank,
        score: value.roster_value_score,
        lineup_adjusted_value: value.lineup_adjusted_value_raw
      } : null
    };
  }).sort((a, b) =>
    b.championships - a.championships ||
    b.regular_season.wins - a.regular_season.wins ||
    b.regular_season.win_pct - a.regular_season.win_pct ||
    String(a.current_team_name).localeCompare(String(b.current_team_name))
  );
  output.forEach((row, index) => { row.franchise_rank = index + 1; });
  return output;
}

function buildOwnerArchetypes({ ownerTendenciesDoc, directory, powerRankingsDoc }) {
  const powerByOwner = new Map((powerRankingsDoc?.rankings || []).map(row => [String(row.owner_id), row]));
  const rows = (ownerTendenciesDoc?.owners || []).map(owner => {
    const identity = directory.owners.get(owner.owner_key) || {
      owner_key: owner.owner_key,
      owner_id: owner.owner_id,
      display_name: owner.display_name,
      current_team_name: owner.current_team_name,
      current_roster_id: owner.current_roster_id
    };
    const power = owner.owner_id ? powerByOwner.get(String(owner.owner_id)) : null;
    return {
      identity,
      trades: Number(owner.trade_profile?.trades || 0),
      transactions: Number(owner.activity?.transactions_involved || 0),
      waiver_moves: Number(owner.activity?.waiver_claims_won || 0) * 2 + Number(owner.activity?.free_agent_transactions || 0),
      firsts_sent: Number(owner.trade_profile?.firsts_sent || 0),
      picks_sent: Number(owner.trade_profile?.draft_picks_sent || 0),
      net_picks: Number(owner.trade_profile?.net_draft_picks || 0),
      future_firsts: Number(owner.current_draft_capital?.first_round_picks || 0),
      average_age: finiteNumber(power?.roster_profile?.average_age),
      power_score: finiteNumber(power?.power_score),
      power_rank: finiteNumber(power?.rank)
    };
  });

  const scores = {
    trades: percentileScores(rows, row => row.trades),
    transactions: percentileScores(rows, row => row.transactions),
    waivers: percentileScores(rows, row => row.waiver_moves),
    aggression: percentileScores(rows, row => row.firsts_sent * 3 + row.picks_sent),
    net_picks: percentileScores(rows, row => row.net_picks),
    future_firsts: percentileScores(rows, row => row.future_firsts),
    youth: percentileScores(rows, row => row.average_age == null ? null : -row.average_age)
  };

  return rows.map((row, index) => {
    const contenderScore = row.power_score == null ? 50 : clamp(row.power_score, 0, 100);
    const categoryScores = {
      deal_maker: round2(0.75 * scores.trades[index] + 0.25 * scores.aggression[index]),
      waiver_hawk: round2(0.70 * scores.waivers[index] + 0.30 * scores.transactions[index]),
      future_builder: round2(
        0.35 * scores.future_firsts[index] +
        0.30 * scores.net_picks[index] +
        0.35 * scores.youth[index]
      ),
      win_now: round2(0.75 * contenderScore + 0.25 * scores.aggression[index])
    };
    const sorted = Object.entries(categoryScores).sort((a, b) => b[1] - a[1]);
    const top = sorted[0];
    const second = sorted[1];
    const primaryKey = top[1] < 60 || (top[1] - second[1] < 4 && top[1] < 75)
      ? "balanced"
      : top[0];
    const primary = ARCHETYPE_LABELS[primaryKey];
    return {
      ...ownerOutput(row.identity),
      primary_archetype: {
        id: primaryKey,
        label: primary.label,
        description: primary.description,
        confidence_score: primaryKey === "balanced"
          ? 60
          : round2(clamp(50 + (top[1] - second[1]) * 3, 50, 95))
      },
      secondary_traits: sorted.slice(0, 2).map(([id, score]) => ({
        id,
        label: ARCHETYPE_LABELS[id].label,
        score
      })),
      style_scores: categoryScores,
      evidence: {
        completed_trades: row.trades,
        transactions_involved: row.transactions,
        waiver_and_free_agent_activity_score_raw: row.waiver_moves,
        first_round_picks_sent: row.firsts_sent,
        net_draft_picks_acquired: row.net_picks,
        current_future_firsts: row.future_firsts,
        current_average_roster_age: row.average_age,
        current_power_rank: row.power_rank,
        current_power_score: row.power_score
      }
    };
  }).sort((a, b) =>
    Number(a.current_roster_id || 999) - Number(b.current_roster_id || 999)
  );
}

function buildSeasonSummaries({
  gameHistoryDoc,
  completedGames,
  weeklyContexts,
  bySeasonLuck,
  champions,
  directory
}) {
  const seasons = (gameHistoryDoc?.seasons || []).map(row => String(row.season));
  const championBySeason = new Map(champions.map(row => [row.season, row]));
  return seasons.map(season => {
    const games = completedGames.filter(game => String(game.season) === season);
    const regular = games.filter(game => game.phase === "regular");
    const postseason = games.filter(game => game.phase !== "regular");
    const teamMap = new Map();
    for (const game of regular) {
      for (const [side, opponent] of [[game.team_1, game.team_2], [game.team_2, game.team_1]]) {
        const performance = teamPerformance(game, side, opponent, directory);
        if (!teamMap.has(performance.owner_key)) {
          teamMap.set(performance.owner_key, {
            ...compactOwner(performance),
            wins: 0,
            losses: 0,
            ties: 0,
            points: 0
          });
        }
        const row = teamMap.get(performance.owner_key);
        row.wins += performance.result === "win" ? 1 : 0;
        row.losses += performance.result === "loss" ? 1 : 0;
        row.ties += performance.result === "tie" ? 1 : 0;
        row.points += performance.points;
      }
    }
    const teamRows = [...teamMap.values()];
    const luckRows = bySeasonLuck.filter(row => row.season === season);
    const contexts = weeklyContexts.filter(row => row.season === season);
    const performances = contexts.flatMap(context => context.teams);
    const scoringChampion = maxBy(teamRows, row => row.points);
    const bestRecord = maxBy(teamRows, row => row.wins + 0.5 * row.ties + row.points / 100000);
    const allPlayChampion = minBy(luckRows, row => row.all_play_rank);
    return {
      season,
      status: games.length ? "completed_games_available" : "awaiting_completed_games",
      completed_games: games.length,
      completed_regular_season_games: regular.length,
      completed_postseason_games: postseason.length,
      champion: championBySeason.get(season) || null,
      regular_season_best_record: bestRecord ? {
        ...bestRecord,
        points: round2(bestRecord.points)
      } : null,
      regular_season_scoring_champion: scoringChampion ? {
        ...scoringChampion,
        points: round2(scoringChampion.points)
      } : null,
      all_play_champion: allPlayChampion || null,
      luckiest_team: maxBy(luckRows, row => row.luck_wins),
      unluckiest_team: minBy(luckRows, row => row.luck_wins),
      highest_weekly_score: compactPerformance(maxBy(performances, row => row.points)),
      lowest_weekly_score: compactPerformance(minBy(performances, row => row.points))
    };
  });
}

function buildAwards({ weeklyContexts, leagueRecords, rivalries, seasonSummaries }) {
  const latest = [...weeklyContexts].sort((a, b) =>
    Number(b.season) - Number(a.season) || b.week - a.week || String(b.phase).localeCompare(String(a.phase))
  )[0] || null;
  let latestAwards = null;
  if (latest) {
    const starters = [];
    const bench = [];
    for (const wrapped of latest.games) {
      for (const [side, opponent, performance] of [
        [wrapped.game.team_1, wrapped.game.team_2, wrapped.first],
        [wrapped.game.team_2, wrapped.game.team_1, wrapped.second]
      ]) {
        for (const player of (side?.starters || [])) {
          const points = finiteNumber(player?.fantasy_points);
          if (points !== null) starters.push({
            ...compactOwner(performance),
            player_id: player.player_id || null,
            player_name: player.name || player.player_id || null,
            position: player.position || null,
            fantasy_points: points,
            opponent_team_name: opponent?.team_name || null
          });
        }
        for (const player of (side?.players || [])) {
          if (player?.started) continue;
          const points = finiteNumber(player?.fantasy_points);
          if (points !== null) bench.push({
            ...compactOwner(performance),
            player_id: player.player_id || null,
            player_name: player.name || player.player_id || null,
            position: player.position || null,
            fantasy_points: points,
            opponent_team_name: opponent?.team_name || null
          });
        }
      }
    }
    const fortunes = buildWeeklyFortuneRecords([latest]);
    latestAwards = {
      season: latest.season,
      week: latest.week,
      phase: latest.phase,
      top_score: compactPerformance(maxBy(latest.teams, row => row.points)),
      low_score: compactPerformance(minBy(latest.teams, row => row.points)),
      player_of_the_week: compactPlayerPerformance(maxBy(starters, row => row.fantasy_points)),
      bench_explosion: compactPlayerPerformance(maxBy(bench, row => row.fantasy_points)),
      heartbreak: fortunes.worst_bad_beat,
      escape_artist: fortunes.luckiest_win,
      biggest_blowout: leagueRecordForContext(latest, "max")
    };
  }

  return {
    latest_completed_week: latestAwards,
    all_time: {
      scoring_crown: leagueRecords.team_game_records.highest_score,
      heartbreak_hall_of_fame: leagueRecords.fortune_records.worst_bad_beat,
      escape_artist_hall_of_fame: leagueRecords.fortune_records.luckiest_win,
      player_game_record: leagueRecords.player_records.highest_starter_score,
      bench_game_record: leagueRecords.player_records.highest_bench_score,
      biggest_blowout: leagueRecords.matchup_records.largest_margin,
      top_rivalry: rivalries[0] || null
    },
    by_season: seasonSummaries.map(summary => ({
      season: summary.season,
      champion: summary.champion,
      scoring_champion: summary.regular_season_scoring_champion,
      all_play_champion: summary.all_play_champion,
      luckiest_team: summary.luckiest_team,
      unluckiest_team: summary.unluckiest_team,
      highest_weekly_score: summary.highest_weekly_score
    }))
  };
}

function leagueRecordForContext(context, direction) {
  const rows = context.games.map(({ first, second }) => ({
    season: context.season,
    week: context.week,
    phase: context.phase,
    team_1: compactPerformance(first),
    team_2: compactPerformance(second),
    margin: round2(Math.abs(first.points - second.points))
  }));
  return direction === "min" ? minBy(rows, row => row.margin) : maxBy(rows, row => row.margin);
}

function compareAgainstField(team, teams) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const opponent of teams) {
    if (opponent.owner_key === team.owner_key) continue;
    if (team.points > opponent.points) wins += 1;
    else if (team.points < opponent.points) losses += 1;
    else ties += 1;
  }
  return { wins, losses, ties, possible: wins + losses + ties };
}

function addRanks(rows, keyAccessor, specifications, groupAccessor = null) {
  const groups = new Map();
  for (const row of rows) {
    const group = groupAccessor ? groupAccessor(row) : "all";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  for (const groupRows of groups.values()) {
    for (const [field, accessor, descending] of specifications) {
      const values = [...new Set(groupRows.map(row => Number(accessor(row))).filter(Number.isFinite))]
        .sort((a, b) => descending ? b - a : a - b);
      for (const row of groupRows) {
        const value = Number(accessor(row));
        row[field] = Number.isFinite(value) ? values.indexOf(value) + 1 : null;
        keyAccessor(row);
      }
    }
  }
}

function percentileScores(rows, accessor) {
  const values = rows.map(accessor).map(finiteNumber);
  const available = [...new Set(values.filter(value => value !== null))].sort((a, b) => a - b);
  return values.map(value => {
    if (value === null) return 50;
    if (available.length <= 1) return available.length ? 50 : 0;
    return round2(100 * available.indexOf(value) / (available.length - 1));
  });
}

function isCompletedGame(game) {
  return Boolean(
    game?.is_completed === true &&
    game.team_1 &&
    game.team_2 &&
    finiteNumber(game.team_1.points) !== null &&
    finiteNumber(game.team_2.points) !== null
  );
}

function compareGames(a, b) {
  return Number(a.season) - Number(b.season) ||
    Number(a.week) - Number(b.week) ||
    Number(a.matchup_id || 0) - Number(b.matchup_id || 0);
}

function compactPerformance(row) {
  if (!row) return null;
  return {
    season: row.season,
    week: row.week,
    phase: row.phase,
    matchup_id: row.matchup_id ?? null,
    ...compactOwner(row),
    historical_team_name: row.historical_team_name || null,
    opponent_team_name: row.opponent_team_name || null,
    points: round2(row.points),
    opponent_points: round2(row.opponent_points),
    result: row.result || null
  };
}

function compactPlayerPerformance(row) {
  if (!row) return null;
  return {
    season: row.season,
    week: row.week,
    phase: row.phase,
    owner_key: row.owner_key,
    current_team_name: row.current_team_name,
    historical_team_name: row.historical_team_name || null,
    opponent_team_name: row.opponent_team_name || null,
    player_id: row.player_id,
    player_name: row.player_name,
    position: row.position,
    fantasy_points: round2(row.fantasy_points)
  };
}

function compactOwner(row) {
  if (!row) return null;
  return {
    owner_key: row.owner_key,
    owner_id: row.owner_id || null,
    display_name: row.display_name || null,
    current_roster_id: finiteNumber(row.current_roster_id ?? row.roster_id),
    current_team_name: row.current_team_name || null
  };
}

function ownerOutput(identity) {
  return compactOwner(identity || {});
}

function emptyRecord() {
  return { wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 };
}

function updateRecord(record, performance) {
  record.wins += performance.result === "win" ? 1 : 0;
  record.losses += performance.result === "loss" ? 1 : 0;
  record.ties += performance.result === "tie" ? 1 : 0;
  record.points_for += performance.points;
  record.points_against += performance.opponent_points;
}

function finalizeRecord(record) {
  const games = record.wins + record.losses + record.ties;
  return {
    wins: record.wins,
    losses: record.losses,
    ties: record.ties,
    games,
    win_pct: games ? round3((record.wins + 0.5 * record.ties) / games) : 0,
    points_for: round2(record.points_for),
    points_against: round2(record.points_against),
    points_per_game: games ? round2(record.points_for / games) : 0
  };
}

function maxBy(rows, accessor) {
  let best = null;
  let bestValue = -Infinity;
  for (const row of rows || []) {
    const value = Number(accessor(row));
    if (Number.isFinite(value) && value > bestValue) {
      best = row;
      bestValue = value;
    }
  }
  return best;
}

function minBy(rows, accessor) {
  let best = null;
  let bestValue = Infinity;
  for (const row of rows || []) {
    const value = Number(accessor(row));
    if (Number.isFinite(value) && value < bestValue) {
      best = row;
      bestValue = value;
    }
  }
  return best;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function round3(value) {
  return Number(Number(value || 0).toFixed(3));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
