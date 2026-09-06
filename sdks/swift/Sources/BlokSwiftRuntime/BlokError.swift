import Foundation

public enum BlokErrorCategory: String, Sendable, Codable {
    case validation = "VALIDATION"
    case configuration = "CONFIGURATION"
    case dependency = "DEPENDENCY"
    case timeout = "TIMEOUT"
    case permission = "PERMISSION"
    case rateLimit = "RATE_LIMIT"
    case notFound = "NOT_FOUND"
    case conflict = "CONFLICT"
    case cancelled = "CANCELLED"
    case internalError = "INTERNAL"
    case protocolError = "PROTOCOL"
    case data = "DATA"
}

public enum BlokErrorSeverity: String, Sendable, Codable {
    case info = "INFO"
    case warn = "WARN"
    case error = "ERROR"
    case fatal = "FATAL"
}

public struct BlokError: Error, Sendable {
    public var code: String
    public var category: BlokErrorCategory
    public var severity: BlokErrorSeverity
    public var node: String?
    public var message: String
    public var description: String
    public var remediation: String
    public var httpStatus: Int32
    public var retryable: Bool
    public var retryAfterMs: Int64
    public var details: [String: AnySendable]?
    public var at: Date

    public init(
        code: String,
        category: BlokErrorCategory,
        severity: BlokErrorSeverity = .error,
        node: String? = nil,
        message: String,
        description: String = "",
        remediation: String = "",
        httpStatus: Int32 = 500,
        retryable: Bool = false,
        retryAfterMs: Int64 = 0,
        details: [String: AnySendable]? = nil,
        at: Date = Date()
    ) {
        self.code = code
        self.category = category
        self.severity = severity
        self.node = node
        self.message = message
        self.description = description
        self.remediation = remediation
        self.httpStatus = httpStatus
        self.retryable = retryable
        self.retryAfterMs = retryAfterMs
        self.details = details
        self.at = at
    }

    public static func validation(code: String = "NODE_INPUT_VALIDATION", message: String, details: [String: AnySendable]? = nil) -> Self {
        Self(code: code, category: .validation, message: message, httpStatus: 400, details: details)
    }

    public static func permission(code: String, message: String, details: [String: AnySendable]? = nil) -> Self {
        Self(code: code, category: .permission, message: message, httpStatus: 403, details: details)
    }

    public static func timeout(message: String = "Node execution exceeded its deadline") -> Self {
        Self(code: "NODE_TIMEOUT", category: .timeout, message: message, httpStatus: 504, retryable: true)
    }

    public static func cancelled(message: String = "Node execution was cancelled") -> Self {
        Self(code: "NODE_CANCELLED", category: .cancelled, message: message, httpStatus: 499)
    }
}

/// JSON-compatible, Sendable details without introducing a second wire format.
public enum AnySendable: Sendable {
    case string(String)
    case integer(Int)
    case boolean(Bool)
    case strings([String])
}
