-- Every player of a game in the marts gave at least one order: valid_replays leaves out the rest.
SELECT rp.replay_id, rp.player_id
FROM {{ ref('replay_players') }} AS rp
LEFT ANTI JOIN (SELECT DISTINCT replay_id, player_id FROM {{ ref('player_order_events') }}) AS o
    ON o.replay_id = rp.replay_id AND o.player_id = rp.player_id
