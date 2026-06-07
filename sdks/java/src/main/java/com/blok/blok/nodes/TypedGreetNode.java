package com.blok.blok.nodes;

import com.blok.blok.node.TypedNode;
import com.blok.blok.types.Context;

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
    protected Output run(Context ctx, Input input) {
        int repeat = input.repeat() > 0 ? input.repeat() : 1;
        String greeting = ("Hello, " + input.name()).repeat(repeat);
        return new Output(greeting, greeting.length());
    }
}
