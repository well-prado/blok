package com.blok.intellij;

import com.redhat.devtools.lsp4ij.LanguageServerFactory;
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider;
import com.redhat.devtools.lsp4ij.server.ProcessStreamConnectionProvider;
import org.jetbrains.annotations.NotNull;

import java.util.Arrays;
import java.util.List;

/**
 * Factory that creates the Blok LSP server process.
 *
 * Launches {@code blok-lsp --stdio} and connects to it via stdin/stdout.
 * The {@code blok-lsp} binary must be installed globally or available on PATH.
 */
public class BlokLspServerFactory implements LanguageServerFactory {

    @Override
    public @NotNull StreamConnectionProvider createConnectionProvider() {
        List<String> commands = Arrays.asList("blok-lsp", "--stdio");
        return new ProcessStreamConnectionProvider(commands);
    }
}
