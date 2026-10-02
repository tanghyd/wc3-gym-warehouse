-- Returns each player_games row with a filled opener_N after an empty opener_N-1.
SELECT replay_id, player_id, opener_1, opener_2, opener_3, opener_4, opener_5, opener_6
FROM {{ ref('player_games') }}
WHERE (opener_1 = '' AND opener_2 != '')
   OR (opener_2 = '' AND opener_3 != '')
   OR (opener_3 = '' AND opener_4 != '')
   OR (opener_4 = '' AND opener_5 != '')
   OR (opener_5 = '' AND opener_6 != '')
