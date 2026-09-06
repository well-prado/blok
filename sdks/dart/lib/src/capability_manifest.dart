class CapabilityManifest {
  const CapabilityManifest({
    required this.effects,
    required this.requiredCapabilities,
    this.version = '1',
    this.classification = 'agent-compatible',
    this.capabilities = const [],
    this.secrets = const [],
    this.status = 'agent-compatible',
    this.determinism = 'unknown',
    this.idempotency = 'unknown',
    this.maturity = 'stable',
    this.resourceBounds = const {},
  });

  const CapabilityManifest.agentCompatible({
    required List<String> effects,
    required List<String> requiredCapabilities,
    String determinism = 'unknown',
    String idempotency = 'unknown',
    String maturity = 'stable',
    Map<String, Object?> resourceBounds = const {},
  }) : this(
          effects: effects,
          requiredCapabilities: requiredCapabilities,
          determinism: determinism,
          idempotency: idempotency,
          maturity: maturity,
          resourceBounds: resourceBounds,
        );

  final List<String> effects;
  final List<String> requiredCapabilities;
  final String version;
  final String classification;
  final List<String> capabilities;
  final List<String> secrets;
  final String status;
  final String determinism;
  final String idempotency;
  final String maturity;
  final Map<String, Object?> resourceBounds;

  Map<String, Object?> toJson() => {
        'version': version,
        'classification': classification,
        'effects': effects,
        'capabilities':
            capabilities.isEmpty ? requiredCapabilities : capabilities,
        'secrets': secrets,
        'determinism': determinism,
        'idempotency': idempotency,
        'maturity': maturity,
        if (resourceBounds.isNotEmpty) 'resources': resourceBounds,
      };
}
