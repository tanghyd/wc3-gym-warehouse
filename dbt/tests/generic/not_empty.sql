{% test not_empty(model, column_name) %}
-- A ClickHouse column that cannot hold NULL still has its type's default: '' for text, 0
-- for a number, the epoch for a time. A row at that default is a missing value, which
-- not_null can never see on such a column.
SELECT {{ column_name }}
FROM {{ model }}
WHERE {{ column_name }} = defaultValueOfArgumentType({{ column_name }})
{% endtest %}
