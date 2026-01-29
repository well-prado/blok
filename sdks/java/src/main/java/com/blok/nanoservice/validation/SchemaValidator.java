package com.blok.nanoservice.validation;

import com.google.gson.Gson;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Lightweight JSON Schema validator supporting a subset of JSON Schema Draft 7.
 * <p>
 * Supported keywords: type, required, properties, enum, minLength, maxLength,
 * minimum, maximum.
 */
public class SchemaValidator {

    private static final Gson GSON = new Gson();

    /**
     * Validates data against a JSON Schema.
     *
     * @param data   the data to validate
     * @param schema the JSON Schema as a map
     * @return a list of validation errors (empty if valid)
     */
    public List<String> validate(Object data, Map<String, Object> schema) {
        List<String> errors = new ArrayList<>();
        if (schema == null) {
            return errors;
        }
        validateValue(data, schema, "", errors);
        return errors;
    }

    @SuppressWarnings("unchecked")
    private void validateValue(Object data, Map<String, Object> schema, String path, List<String> errors) {
        if (schema == null) {
            return;
        }

        // Type check
        Object schemaType = schema.get("type");
        if (schemaType instanceof String typeStr) {
            if (!checkType(data, typeStr)) {
                errors.add(pathStr(path) + ": expected type \"" + typeStr + "\", got " + describeType(data));
                return;
            }
        }

        // Enum check
        Object enumVal = schema.get("enum");
        if (enumVal instanceof List<?> enumList) {
            if (!checkEnum(data, enumList)) {
                errors.add(pathStr(path) + ": value not in allowed enum values");
            }
        }

        // Object properties
        Object propsVal = schema.get("properties");
        if (propsVal instanceof Map<?, ?> props && data instanceof Map<?, ?> dataMap) {
            for (Map.Entry<?, ?> entry : props.entrySet()) {
                String propName = String.valueOf(entry.getKey());
                if (entry.getValue() instanceof Map<?, ?> propSchema) {
                    String propPath = path.isEmpty() ? propName : path + "." + propName;
                    Object propData = dataMap.get(propName);
                    if (propData != null) {
                        validateValue(propData, (Map<String, Object>) propSchema, propPath, errors);
                    }
                }
            }
        }

        // Required fields
        Object requiredVal = schema.get("required");
        if (requiredVal instanceof List<?> requiredList && data instanceof Map<?, ?> dataMap) {
            for (Object req : requiredList) {
                String fieldName = String.valueOf(req);
                if (!dataMap.containsKey(fieldName)) {
                    errors.add(pathStr(path) + ": missing required field \"" + fieldName + "\"");
                }
            }
        }

        // String constraints
        if (data instanceof String str) {
            Object minLenVal = schema.get("minLength");
            if (minLenVal instanceof Number minLen) {
                if (str.length() < minLen.intValue()) {
                    errors.add(pathStr(path) + ": string length " + str.length()
                            + " is less than minimum " + minLen.intValue());
                }
            }
            Object maxLenVal = schema.get("maxLength");
            if (maxLenVal instanceof Number maxLen) {
                if (str.length() > maxLen.intValue()) {
                    errors.add(pathStr(path) + ": string length " + str.length()
                            + " exceeds maximum " + maxLen.intValue());
                }
            }
        }

        // Numeric constraints
        Double num = toDouble(data);
        if (num != null) {
            Object minVal = schema.get("minimum");
            if (minVal instanceof Number minimum) {
                if (num < minimum.doubleValue()) {
                    errors.add(pathStr(path) + ": value " + num
                            + " is less than minimum " + minimum.doubleValue());
                }
            }
            Object maxVal = schema.get("maximum");
            if (maxVal instanceof Number maximum) {
                if (num > maximum.doubleValue()) {
                    errors.add(pathStr(path) + ": value " + num
                            + " exceeds maximum " + maximum.doubleValue());
                }
            }
        }
    }

    private boolean checkType(Object data, String expectedType) {
        if (data == null) {
            return "null".equals(expectedType);
        }
        return switch (expectedType) {
            case "string" -> data instanceof String;
            case "number" -> data instanceof Number;
            case "integer" -> {
                if (data instanceof Number num) {
                    double d = num.doubleValue();
                    yield d == Math.floor(d) && !Double.isInfinite(d);
                }
                yield false;
            }
            case "boolean" -> data instanceof Boolean;
            case "object" -> data instanceof Map;
            case "array" -> data instanceof List;
            case "null" -> false; // data is not null at this point
            default -> true;
        };
    }

    private boolean checkEnum(Object data, List<?> enumValues) {
        String dataJson = GSON.toJson(data);
        for (Object allowed : enumValues) {
            String allowedJson = GSON.toJson(allowed);
            if (dataJson.equals(allowedJson)) {
                return true;
            }
        }
        return false;
    }

    private Double toDouble(Object data) {
        if (data instanceof Number num) {
            return num.doubleValue();
        }
        return null;
    }

    private String describeType(Object data) {
        if (data == null) return "null";
        if (data instanceof String) return "string";
        if (data instanceof Boolean) return "boolean";
        if (data instanceof Number) return "number";
        if (data instanceof Map) return "object";
        if (data instanceof List) return "array";
        return data.getClass().getSimpleName();
    }

    private String pathStr(String path) {
        if (path == null || path.isEmpty()) {
            return "$";
        }
        return "$." + path;
    }
}
