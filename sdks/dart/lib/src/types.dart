typedef JsonObject = Map<String, Object?>;

class RequestContext {
  const RequestContext({
    this.body,
    this.headers = const {},
    this.params = const {},
    this.query = const {},
    this.cookies = const {},
    this.method = '',
    this.url = '',
    this.baseUrl = '',
  });

  final Object? body;
  final Map<String, String> headers;
  final Map<String, String> params;
  final Map<String, String> query;
  final Map<String, String> cookies;
  final String method;
  final String url;
  final String baseUrl;
}

class ExecutionContext {
  ExecutionContext({
    required this.runId,
    required this.workflowName,
    required this.request,
    required this.previousOutput,
    required this.vars,
    required this.env,
    required this.deadline,
    this.stepName = '',
  });

  final String runId;
  final String workflowName;
  final RequestContext request;
  final Object? previousOutput;
  final JsonObject vars;
  final Map<String, String> env;
  final DateTime? deadline;
  final String stepName;
  final List<LogEntry> logs = [];
  final List<Object?> partialResults = [];

  bool get isCancelled => _cancelled;
  bool _cancelled = false;

  void cancel() => _cancelled = true;

  void log(String message,
      {String level = 'info', Map<String, String> attributes = const {}}) {
    logs.add(LogEntry(level: level, message: message, attributes: attributes));
  }

  void emit(Object? value) => partialResults.add(value);

  void checkActive() {
    if (_cancelled) throw const BlokCancellationException();
    if (deadline != null && DateTime.now().toUtc().isAfter(deadline!)) {
      throw const BlokDeadlineException();
    }
  }
}

class LogEntry {
  const LogEntry(
      {required this.level, required this.message, this.attributes = const {}});
  final String level;
  final String message;
  final Map<String, String> attributes;
}

class BlokCancellationException implements Exception {
  const BlokCancellationException();
  @override
  String toString() => 'Node execution was cancelled';
}

class BlokDeadlineException implements Exception {
  const BlokDeadlineException();
  @override
  String toString() => 'Node execution exceeded its deadline';
}
