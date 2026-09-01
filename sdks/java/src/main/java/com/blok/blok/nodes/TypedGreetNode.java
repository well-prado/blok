package com.blok.blok.nodes;

import com.blok.blok.node.TypedNode;
import com.blok.blok.node.CapabilityManifest;
import com.blok.blok.types.Context;
import java.util.List;

/** Typed greeting node demonstrating the SPEC-B TypedNode contract. */
public final class TypedGreetNode extends TypedNode<TypedGreetNode.Input, TypedGreetNode.Output> {

    public record Input(String name, int repeat) {
    }

    public record Output(String greeting, int length) {
    }

    @Override
    public String name() {
        return "typed-greet";
    }

    @Override
    public String description() {
        return "Typed greeting (SPEC-B contract demo)";
    }

    @Override
    protected Class<Input> inputClass() {
        return Input.class;
    }

    @Override
    protected Class<?> outputClass() {
        return Output.class;
    }

    @Override
    protected CapabilityManifest capabilityManifest() {
        return new CapabilityManifest(
                "1", "agent-compatible", List.of(), List.of(), List.of(),
                "deterministic", "idempotent", "stable",
                new CapabilityManifest.ResourceBounds(5000L, null, 4194304L, 4194304L, 64L),
                null, null);
    }

    @Override
    protected Output run(Context ctx, Input input) {
        int repeat = input.repeat() > 0 ? input.repeat() : 1;
        String greeting = ("Hello, " + input.name()).repeat(repeat);
        return new Output(greeting, greeting.length());
    }
}
