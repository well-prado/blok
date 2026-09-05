import 'dart:io';

Future<void> main() async {
  final result = await Process.run('protoc', [
    '-I=proto',
    '--dart_out=grpc:lib/src/generated',
    'proto/blok/runtime/v1/runtime.proto',
  ]);
  if (result.exitCode != 0) {
    stderr.write(result.stderr);
    exit(result.exitCode);
  }
}
