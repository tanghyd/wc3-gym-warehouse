{# The parser's race letter as the GNL app's race id (HU OC NE UD RANDOM), the
   vocabulary every mart and the API speak. raw_replays keeps the letter. #}
{% macro gnl_race(expr) -%}
toLowCardinality(transform({{ expr }}, ['H', 'O', 'N', 'U', 'R'], ['HU', 'OC', 'NE', 'UD', 'RANDOM'], {{ expr }}))
{%- endmacro %}
