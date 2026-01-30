package com.blok.blok.types;

import com.google.gson.annotations.SerializedName;

import java.util.Objects;

/**
 * Captures performance metrics for a node execution.
 * Null fields are omitted during JSON serialization.
 */
public class ExecutionMetrics {

    @SerializedName("duration_ms")
    private Double durationMs;

    @SerializedName("cpu_ms")
    private Double cpuMs;

    @SerializedName("memory_bytes")
    private Long memoryBytes;

    public ExecutionMetrics() {
    }

    public ExecutionMetrics(Double durationMs, Double cpuMs, Long memoryBytes) {
        this.durationMs = durationMs;
        this.cpuMs = cpuMs;
        this.memoryBytes = memoryBytes;
    }

    // Getters and setters

    public Double getDurationMs() {
        return durationMs;
    }

    public void setDurationMs(Double durationMs) {
        this.durationMs = durationMs;
    }

    public Double getCpuMs() {
        return cpuMs;
    }

    public void setCpuMs(Double cpuMs) {
        this.cpuMs = cpuMs;
    }

    public Long getMemoryBytes() {
        return memoryBytes;
    }

    public void setMemoryBytes(Long memoryBytes) {
        this.memoryBytes = memoryBytes;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        ExecutionMetrics that = (ExecutionMetrics) o;
        return Objects.equals(durationMs, that.durationMs) &&
                Objects.equals(cpuMs, that.cpuMs) &&
                Objects.equals(memoryBytes, that.memoryBytes);
    }

    @Override
    public int hashCode() {
        return Objects.hash(durationMs, cpuMs, memoryBytes);
    }

    @Override
    public String toString() {
        return "ExecutionMetrics{" +
                "durationMs=" + durationMs +
                ", cpuMs=" + cpuMs +
                ", memoryBytes=" + memoryBytes +
                '}';
    }
}
