import Foundation

public enum ClaimCheckResolver {
    public static let capability = "blob-v1"
    private static let maxCeiling = 256 * 1024 * 1024

    public static func capabilities(environment: [String: String] = ProcessInfo.processInfo.environment) -> [String] {
        guard let directory = environment["BLOK_BLOB_DIR"],
              FileManager.default.isReadableFile(atPath: directory) else { return [] }
        return [capability]
    }

    public static func resolve(
        _ input: Data,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> Data {
        guard let object = try JSONSerialization.jsonObject(with: input) as? [String: Any],
              let blob = object["$blokBlob"] as? [String: Any] else { return input }
        guard let directory = environment["BLOK_BLOB_DIR"] else {
            throw BlokError(code: "BLOB_DIR_UNSET", category: .configuration, message: "BLOK_BLOB_DIR is required for claim-check inputs", httpStatus: 500)
        }
        guard let id = blob["id"] as? String,
              id.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil else {
            throw BlokError(code: "BLOB_ID_INVALID", category: .data, message: "Claim-check id contains unsafe path characters", httpStatus: 400)
        }
        let maxBytes = min(
            max(1, Int(environment["BLOK_BLOB_MAX_BYTES"] ?? "16777216") ?? 16777216),
            maxCeiling
        )
        let root = URL(fileURLWithPath: directory, isDirectory: true).resolvingSymlinksInPath()
        let url = root.appendingPathComponent(id, isDirectory: false).resolvingSymlinksInPath()
        guard url.path.hasPrefix(root.path + "/") else {
            throw BlokError(code: "BLOB_PATH_INVALID", category: .data, message: "Claim-check path escapes BLOK_BLOB_DIR", httpStatus: 400)
        }
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        guard let size = values.fileSize, size <= maxBytes else {
            throw BlokError(code: "BLOB_TOO_LARGE", category: .data, message: "Claim-check payload exceeds the configured read bound", httpStatus: 413)
        }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard data.count <= maxBytes else {
            throw BlokError(code: "BLOB_TOO_LARGE", category: .data, message: "Claim-check payload exceeds the configured read bound", httpStatus: 413)
        }
        _ = try JSONSerialization.jsonObject(with: data)
        return data
    }
}
