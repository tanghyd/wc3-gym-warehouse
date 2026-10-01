{# The parser's race letter as a race code (HU OC NE UD RANDOM), the vocabulary
   every mart and the API speak. raw_replays keeps the letter. #}
{% macro race_code(expr) -%}
toLowCardinality(transform({{ expr }}, ['H', 'O', 'N', 'U', 'R'], ['HU', 'OC', 'NE', 'UD', 'RANDOM'], {{ expr }}))
{%- endmacro %}
