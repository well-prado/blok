package com.blok.blok.types;

import com.google.gson.annotations.SerializedName;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Represents node-specific configuration from the Blok runner.
 */
public class NodeConfig {

    private String name;
    private String path;

    @SerializedName("type")
    private String type;

    private Map<String, Object> config;

    public NodeConfig() {
        this.config = new HashMap<>();
    }

    /**
     * Retrieves a string config value with a default.
     *
     * @param key        the config key
     * @param defaultVal the default value if key is missing or not a string
     * @return the config value or default
     */
    public String getConfigString(String key, String defaultVal) {
        if (config == null || key == null) {
            return defaultVal;
        }
        Object value = config.get(key);
        if (value instanceof String) {
            return (String) value;
        }
        return defaultVal;
    }

    /**
     * Retrieves an integer config value with a default.
     *
     * @param key        the config key
     * @param defaultVal the default value if key is missing or not numeric
     * @return the config value or default
     */
    public int getConfigInt(String key, int defaultVal) {
        if (config == null || key == null) {
            return defaultVal;
        }
        Object value = config.get(key);
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        return defaultVal;
    }

    /**
     * Retrieves a boolean config value with a default.
     *
     * @param key        the config key
     * @param defaultVal the default value if key is missing or not a boolean
     * @return the config value or default
     */
    public boolean getConfigBool(String key, boolean defaultVal) {
        if (config == null || key == null) {
            return defaultVal;
        }
        Object value = config.get(key);
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        return defaultVal;
    }

    // Getters and setters

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public Map<String, Object> getConfig() {
        return config;
    }

    public void setConfig(Map<String, Object> config) {
        this.config = config != null ? config : new HashMap<>();
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        NodeConfig that = (NodeConfig) o;
        return Objects.equals(name, that.name) &&
                Objects.equals(path, that.path) &&
                Objects.equals(type, that.type) &&
                Objects.equals(config, that.config);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name, path, type, config);
    }

    @Override
    public String toString() {
        return "NodeConfig{" +
                "name='" + name + '\'' +
                ", path='" + path + '\'' +
                ", type='" + type + '\'' +
                ", config=" + config +
                '}';
    }
}
