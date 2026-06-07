package com.blok.blok.node;

import com.blok.blok.errors.BlokError;
import com.blok.blok.types.Context;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TypedNodeTest {

    record SearchInput(String query, int limit) {
    }

    record SearchOutput(List<String> results, int count) {
    }

    static final class SearchNode extends TypedNode<SearchInput, SearchOutput> {
        @Override
        public String name() {
            return "@acme/search";
        }

        @Override
        public String description() {
            return "Full-text search";
        }

        @Override
        protected Class<SearchInput> inputClass() {
            return SearchInput.class;
        }

        @Override
        protected Class<?> outputClass() {
            return SearchOutput.class;
        }

        @Override
        protected SearchOutput run(Context ctx, SearchInput input) {
            List<String> rows = Collections.nCopies(input.limit(), input.query());
            return new SearchOutput(rows, rows.size());
        }
    }

    @Test
    void validatesInputAndSerializesOutput() throws Exception {
        Object out = new SearchNode().execute(null, Map.of("query", "ada", "limit", 2));
        SearchOutput output = (SearchOutput) out;
        assertEquals(2, output.count());
        assertEquals(List.of("ada", "ada"), output.results());
    }

    @Test
    void invalidInputThrowsStructuredBlokError() {
        BlokError error = assertThrows(BlokError.class, () ->
                new SearchNode().execute(null, Map.of("query", "x", "limit", "not-a-number")));
        assertEquals(400, error.getHttpStatus());
        assertEquals("NODE_INPUT_VALIDATION", error.getCode());
    }

    @Test
    void reflectsSchemasAndDescription() {
        SearchNode node = new SearchNode();
        assertEquals("Full-text search", node.description());
        assertTrue(node.inputSchemaJson().contains("query"));
        assertNotNull(node.outputSchemaJson());
        assertTrue(node.outputSchemaJson().contains("count"));
    }
}
