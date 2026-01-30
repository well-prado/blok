using FluentAssertions;
using Blok.Core.Logging;
using Xunit;
using LogLevel = Blok.Core.Logging.LogLevel;

namespace Blok.Core.Tests.Logging;

public class LoggerTests
{
    [Fact]
    public void Logger_ShouldFilterByLevel()
    {
        var logger = new Logger(LogLevel.Info);
        logger.Debug("hidden");
        logger.Info("visible1");
        logger.Warn("visible2");
        logger.Error("visible3");

        logger.Entries().Should().HaveCount(3);
    }

    [Fact]
    public void Logger_DebugLevel_ShouldCaptureAll()
    {
        var logger = new Logger(LogLevel.Debug);
        logger.Debug("d");
        logger.Info("i");
        logger.Warn("w");
        logger.Error("e");

        logger.Entries().Should().HaveCount(4);
    }

    [Fact]
    public void Logger_ErrorLevel_ShouldOnlyCaptureErrors()
    {
        var logger = new Logger(LogLevel.Error);
        logger.Debug("hidden");
        logger.Info("hidden");
        logger.Warn("hidden");
        logger.Error("visible");

        logger.Entries().Should().HaveCount(1);
        logger.Entries()[0].Level.Should().Be(LogLevel.Error);
    }

    [Fact]
    public void Logger_ShouldCaptureFields()
    {
        var logger = new Logger(LogLevel.Debug);
        logger.Info("test", new Dictionary<string, object?> { { "key", "value" } });

        var entries = logger.Entries();
        entries.Should().HaveCount(1);
        entries[0].Fields.Should().NotBeNull();
        entries[0].Fields!["key"].Should().Be("value");
    }

    [Fact]
    public void Logger_Lines_ShouldReturnFormattedStrings()
    {
        var logger = new Logger(LogLevel.Debug);
        logger.Info("hello");
        logger.Error("oops");

        var lines = logger.Lines();
        lines.Should().HaveCount(2);
        lines[0].Should().Contain("[INFO]");
        lines[0].Should().Contain("hello");
        lines[1].Should().Contain("[ERROR]");
        lines[1].Should().Contain("oops");
    }

    [Fact]
    public void Logger_Clear_ShouldRemoveAllEntries()
    {
        var logger = new Logger(LogLevel.Debug);
        logger.Info("test");
        logger.Entries().Should().HaveCount(1);

        logger.Clear();
        logger.Entries().Should().BeEmpty();
    }

    [Fact]
    public void LogEntry_ToString_WithFields_ShouldFormatCorrectly()
    {
        var entry = new LogEntry
        {
            Level = LogLevel.Info,
            Message = "test message",
            Timestamp = new DateTime(2024, 1, 15, 10, 30, 0, DateTimeKind.Utc),
            Fields = new Dictionary<string, object?> { { "key", "value" } }
        };

        var str = entry.ToString();
        str.Should().Contain("[INFO]");
        str.Should().Contain("test message");
        str.Should().Contain("key=value");
    }

    [Fact]
    public void LogEntry_ToString_WithoutFields_ShouldFormatCorrectly()
    {
        var entry = new LogEntry
        {
            Level = LogLevel.Warn,
            Message = "warning",
            Timestamp = DateTime.UtcNow,
            Fields = null
        };

        var str = entry.ToString();
        str.Should().Contain("[WARN]");
        str.Should().Contain("warning");
    }

    [Fact]
    public void Logger_ShouldBeThreadSafe()
    {
        var logger = new Logger(LogLevel.Debug);
        var tasks = Enumerable.Range(0, 100)
            .Select(i => Task.Run(() => logger.Info($"msg {i}")))
            .ToArray();

        Task.WaitAll(tasks);
        logger.Entries().Should().HaveCount(100);
    }
}
