[
  inputs:
    Enum.reject(Path.wildcard("{config,lib,test}/**/*.{ex,exs}"), &String.ends_with?(&1, ".pb.ex")) ++
      ["mix.exs"],
  locals_without_parens: [field: 2, field: 3]
]
