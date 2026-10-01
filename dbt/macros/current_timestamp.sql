{# now() is a DateTime, which dbt 2.0.6 reads back as UInt32 and refuses as the
   freshness snapshot time; now64() reads back as a timestamp. #}
{% macro clickhouse__current_timestamp() -%}
now64(3)
{%- endmacro %}
