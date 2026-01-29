package com.blok.nanoservice.types;

import java.util.Objects;

/**
 * Represents the execution request received from the Blok runner.
 * Contains the node configuration and the workflow execution context.
 */
public class ExecutionRequest {

    private NodeConfig node;
    private Context context;

    public ExecutionRequest() {
    }

    public ExecutionRequest(NodeConfig node, Context context) {
        this.node = node;
        this.context = context;
    }

    // Getters and setters

    public NodeConfig getNode() {
        return node;
    }

    public void setNode(NodeConfig node) {
        this.node = node;
    }

    public Context getContext() {
        return context;
    }

    public void setContext(Context context) {
        this.context = context;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        ExecutionRequest that = (ExecutionRequest) o;
        return Objects.equals(node, that.node) &&
                Objects.equals(context, that.context);
    }

    @Override
    public int hashCode() {
        return Objects.hash(node, context);
    }

    @Override
    public String toString() {
        return "ExecutionRequest{" +
                "node=" + node +
                ", context=" + context +
                '}';
    }
}
