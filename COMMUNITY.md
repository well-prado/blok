# Blok Community

Welcome to the Blok community! We're building the most powerful, developer-friendly, language-agnostic workflow orchestration framework.

## Get Involved

### Discord
Join our Discord server for real-time discussions, support, and community events.

- **#general** — Introductions and general discussion
- **#help** — Get help with Blok development
- **#showcase** — Share what you've built with Blok
- **#runtimes** — Multi-language runtime discussions (Go, Rust, Java, C#, PHP, Ruby)
- **#triggers** — Trigger system discussions (Queue, PubSub, Cron, Webhook, WebSocket, SSE)
- **#ai-generation** — AI-powered code generation tips and feedback
- **#contributors** — For active contributors and maintainers

### Stack Overflow
Ask and answer questions on Stack Overflow using the [`blok-framework`](https://stackoverflow.com/questions/tagged/blok-framework) tag.

**Tips for good questions:**
- Include your Blok version and runtime
- Provide a minimal reproducible example
- Include relevant workflow JSON and node code
- Share error messages and logs

### GitHub Discussions
Use [GitHub Discussions](https://github.com/Deskree/blok/discussions) for:
- **Q&A** — Ask questions about Blok
- **Ideas** — Propose new features or improvements
- **Show and Tell** — Share projects built with Blok
- **General** — Open-ended conversations

### Blog
Read the Blok blog for:
- Release announcements and changelogs
- Architecture deep-dives
- Case studies from production users
- Tutorial series
- Performance benchmarks
- Community spotlights

### Monthly Webinars
Join our monthly community webinars:
- **First Tuesday** — Feature deep-dive and live coding
- **Third Tuesday** — Community showcase and Q&A
- Recordings available on YouTube

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed contribution guidelines.

### Quick Start
1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes with tests
4. Run `pnpm run build && pnpm run test`
5. Submit a pull request

### Areas We Need Help
- **Runtime SDKs** — Improve Go, Rust, Java, C#, PHP, Ruby SDKs
- **Trigger adapters** — New queue/pubsub provider integrations
- **Documentation** — Tutorials, examples, translations
- **Testing** — Integration tests, load tests, chaos tests
- **IDE plugins** — VS Code, IntelliJ, Neovim improvements

## Code of Conduct

All community spaces follow our [Code of Conduct](./CODE_OF_CONDUCT.md). Be respectful, inclusive, and constructive.

## Ecosystem

### Official Packages
| Package | Description |
|---------|-------------|
| `@blok/runner` | Core workflow orchestration engine |
| `@blok/shared` | Shared types and utilities |
| `@blok/helper` | Workflow builder DSL |
| `blokctl` | CLI tooling |
| `@blok/api-call` | HTTP API call node |
| `@blok/if-else` | Conditional routing node |
| `@blok/react` | React SSR node |

### Runtime SDKs
| Language | Package | Status |
|----------|---------|--------|
| TypeScript/Node.js | `@blok/runner` | Production |
| Python 3 | `runtimes/python3` | Production |
| Go | `sdks/go` | Production |
| Java | `sdks/java` | Production |
| Rust | `sdks/rust` | Production |
| C# / .NET | `sdks/csharp` | Production |
| PHP | `sdks/php` | Production |
| Ruby | `sdks/ruby` | Production |

### Trigger Types
| Trigger | Package | Description |
|---------|---------|-------------|
| HTTP | `@blok/trigger-http` | REST API endpoints |
| gRPC | `@blok/trigger-grpc` | gRPC services |
| WebSocket | `@blok/trigger-websocket` | Real-time bidirectional |
| SSE | `@blok/trigger-sse` | Server-Sent Events |
| Queue | `@blok/trigger-queue` | Kafka, RabbitMQ, SQS, Redis |
| PubSub | `@blok/trigger-pubsub` | GCP, AWS SNS, Azure Service Bus |
| Cron | `@blok/trigger-cron` | Scheduled workflows |
| Webhook | `@blok/trigger-webhook` | GitHub, Stripe, Shopify |
| Worker | `@blok/trigger-worker` | Background job processing |

## License

Blok is licensed under [Apache 2.0](./LICENSE).
