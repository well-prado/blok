package com.blok.nanoservice.types;

import com.google.gson.annotations.SerializedName;

import java.util.List;
import java.util.Objects;

/**
 * Represents the health status of the nanoservice runtime.
 */
public class HealthStatus {

    private String status;
    private String version;

    @SerializedName("nodes_loaded")
    private List<String> nodesLoaded;

    public HealthStatus() {
    }

    public HealthStatus(String status, String version, List<String> nodesLoaded) {
        this.status = status;
        this.version = version;
        this.nodesLoaded = nodesLoaded;
    }

    // Getters and setters

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getVersion() {
        return version;
    }

    public void setVersion(String version) {
        this.version = version;
    }

    public List<String> getNodesLoaded() {
        return nodesLoaded;
    }

    public void setNodesLoaded(List<String> nodesLoaded) {
        this.nodesLoaded = nodesLoaded;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        HealthStatus that = (HealthStatus) o;
        return Objects.equals(status, that.status) &&
                Objects.equals(version, that.version) &&
                Objects.equals(nodesLoaded, that.nodesLoaded);
    }

    @Override
    public int hashCode() {
        return Objects.hash(status, version, nodesLoaded);
    }

    @Override
    public String toString() {
        return "HealthStatus{" +
                "status='" + status + '\'' +
                ", version='" + version + '\'' +
                ", nodesLoaded=" + nodesLoaded +
                '}';
    }
}
