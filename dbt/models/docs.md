{# Shared column descriptions. A YAML description references one as doc('name'). #}

{% docs replay_id %}
The replay's id: a hex SHA-256 the parser computes from the game's random seed, the players' names and the game name, so two recordings of one game share it.
{% enddocs %}

{% docs player_id %}
The player's slot id in the replay (1-24), unique within a replay.
{% enddocs %}

{% docs race %}
GNL race id: HU, OC, NE, UD or RANDOM, from the parser's race letter (H, O, N, U, R) by the gnl_race macro. The race the player picked in the lobby, so a random player stays RANDOM.
{% enddocs %}

{% docs matchup %}
The parser's matchup: each team's race letters sorted and joined, then the teams sorted and joined by v, such as HvN or HHNOvHNUU. A letter is the race detected from the player's first order, or the lobby race (R for random) when none was detected.
{% enddocs %}

{% docs time_ms %}
Game time in milliseconds from the start of the game.
{% enddocs %}

{% docs seq %}
Position of the row in its parser list, from 1: the order in which the parser wrote it. It breaks ties between rows on the same millisecond.
{% enddocs %}

{% docs gnl_series_id %}
The GNL series this replay was reported on, from the bucket key replays/<series id>/game<n>.w3g; 0 for a replay from any other source.
{% enddocs %}

{% docs gnl_game_no %}
The game number within the GNL series (game<n> in the bucket key); 0 outside GNL.
{% enddocs %}

{% docs map %}
Readable map name: the map file name without its extension, w3c prefix and version suffix, with camelCase and underscores turned into spaces.
{% enddocs %}

{% docs duration_ms %}
Game length in milliseconds, from the replay header.
{% enddocs %}

{% docs object_code %}
A four-character WC3 object code (rawcode), such as hbar for Barracks; mappings gives its name.
{% enddocs %}

{% docs order_kind %}
The order kind, from the parser list that holds the order: building, unit, item, upgrade, or unknown. unknown holds codes in no melee table, such as hero training orders and custom-map objects.
{% enddocs %}

{% docs order_is_a_command %}
An order is a command, not a finished object, so a repeat click is a second row and a cancelled order still counts.
{% enddocs %}

{% docs event_type %}
The event kind: an order kind (building, unit, item, upgrade, unknown), hero_skill for a skill point spent, or hero_trained for a hero's first skill point, which lands within a second of its summon.
{% enddocs %}

{% docs hero_slot %}
The hero's position in the player's hero list, from 0, in the order the player first spent a skill point on it.
{% enddocs %}

{% docs hero_id %}
The hero's object code, such as Hpal for Paladin.
{% enddocs %}

{% docs player_name %}
The player's battle tag as the replay wrote it, such as Name#1234.
{% enddocs %}
