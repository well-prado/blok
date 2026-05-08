# frozen_string_literal: true

require_relative "lib/blok/version"

Gem::Specification.new do |spec|
  spec.name          = "blok-ruby"
  spec.version       = Blok::VERSION
  spec.authors       = ["Blok Team"]
  spec.email         = ["team@blok.dev"]

  spec.summary       = "Ruby SDK for the Blok blok framework"
  spec.description   = "Production-ready Ruby SDK for building Blok workflow nodes. " \
                        "Provides a base node handler, HTTP runtime server, middleware pipeline, " \
                        "structured logging, schema validation, and testing utilities."
  spec.homepage      = "https://github.com/blok-dev/sdks"
  spec.license       = "MIT"

  spec.required_ruby_version = ">= 3.1"

  spec.metadata["homepage_uri"]    = spec.homepage
  spec.metadata["source_code_uri"] = "https://github.com/blok-dev/sdks/tree/main/ruby"
  spec.metadata["changelog_uri"]   = "https://github.com/blok-dev/sdks/blob/main/ruby/CHANGELOG.md"

  spec.files = Dir.chdir(__dir__) do
    Dir["{lib,examples}/**/*", "Gemfile", "Rakefile", "config.ru", "README.md", "LICENSE.txt"]
  end

  spec.require_paths = ["lib"]

  spec.add_dependency "sinatra",  "~> 4.0"
  spec.add_dependency "puma",     "~> 6.4"
  spec.add_dependency "rackup",   "~> 2.1"

  # gRPC transport — loaded lazily by Server::GrpcServer so HTTP-only
  # deployments don't pay the load-time cost.
  spec.add_dependency "grpc", "~> 1.69"
  spec.add_dependency "google-protobuf", "~> 4.0"

  spec.add_development_dependency "minitest", "~> 5.0"
  spec.add_development_dependency "rake",     "~> 13.0"
  spec.add_development_dependency "rack-test", "~> 2.1"
  spec.add_development_dependency "grpc-tools", "~> 1.69"
end
