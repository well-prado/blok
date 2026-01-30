# frozen_string_literal: true

require_relative "../test_helper"

class LoggerTest < Minitest::Test
  def test_level_filtering_info
    logger = Blok::Logging::Logger.new(:info)
    logger.debug("hidden")
    logger.info("visible1")
    logger.warn("visible2")
    logger.error("visible3")

    assert_equal 3, logger.entries.length
  end

  def test_level_filtering_debug
    logger = Blok::Logging::Logger.new(:debug)
    logger.debug("visible")
    logger.info("visible")

    assert_equal 2, logger.entries.length
  end

  def test_level_filtering_error
    logger = Blok::Logging::Logger.new(:error)
    logger.debug("hidden")
    logger.info("hidden")
    logger.warn("hidden")
    logger.error("visible")

    assert_equal 1, logger.entries.length
  end

  def test_entries_contain_correct_levels
    logger = Blok::Logging::Logger.new(:debug)
    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")

    levels = logger.entries.map(&:level)
    assert_equal %i[debug info warn error], levels
  end

  def test_entries_contain_messages
    logger = Blok::Logging::Logger.new(:debug)
    logger.info("hello world")

    entries = logger.entries
    assert_equal 1, entries.length
    assert_equal "hello world", entries[0].message
  end

  def test_entries_contain_timestamp
    logger = Blok::Logging::Logger.new(:debug)
    logger.info("test")

    entry = logger.entries.first
    assert entry.timestamp
    assert_match(/\d{4}-\d{2}-\d{2}/, entry.timestamp)
  end

  def test_info_with_fields
    logger = Blok::Logging::Logger.new(:debug)
    logger.info("test", fields: { "key" => "value" })

    entry = logger.entries.first
    assert_equal({ "key" => "value" }, entry.fields)
  end

  def test_lines_format
    logger = Blok::Logging::Logger.new(:debug)
    logger.info("hello")
    logger.error("oops")

    lines = logger.lines
    assert_equal 2, lines.length
    assert_match(/\[INFO\]/, lines[0])
    assert_match(/hello/, lines[0])
    assert_match(/\[ERROR\]/, lines[1])
    assert_match(/oops/, lines[1])
  end

  def test_lines_with_fields
    logger = Blok::Logging::Logger.new(:debug)
    logger.info("test", fields: { "x" => 1 })

    line = logger.lines.first
    assert_match(/\[INFO\]/, line)
    assert_match(/"x":1/, line.gsub(" ", ""))
  end

  def test_clear
    logger = Blok::Logging::Logger.new(:debug)
    logger.info("test")
    assert_equal 1, logger.entries.length

    logger.clear
    assert_equal 0, logger.entries.length
  end

  def test_entries_returns_copy
    logger = Blok::Logging::Logger.new(:debug)
    logger.info("test")

    entries = logger.entries
    entries.clear

    # Original should be unaffected
    assert_equal 1, logger.entries.length
  end

  def test_thread_safety
    logger = Blok::Logging::Logger.new(:debug)

    threads = 10.times.map do |i|
      Thread.new { 100.times { logger.info("thread-#{i}") } }
    end
    threads.each(&:join)

    assert_equal 1000, logger.entries.length
  end

  def test_log_entry_to_hash
    entry = Blok::Logging::LogEntry.new(
      level: :info,
      message: "test message",
      fields: { "key" => "val" }
    )

    hash = entry.to_hash
    assert_equal "INFO", hash["level"]
    assert_equal "test message", hash["message"]
    assert hash["timestamp"]
    assert_equal({ "key" => "val" }, hash["fields"])
  end

  def test_log_level_parse
    assert_equal :debug, Blok::Logging::LogLevel.parse("DEBUG")
    assert_equal :info, Blok::Logging::LogLevel.parse("INFO")
    assert_equal :warn, Blok::Logging::LogLevel.parse("WARN")
    assert_equal :error, Blok::Logging::LogLevel.parse("ERROR")
    assert_equal :info, Blok::Logging::LogLevel.parse("unknown")
    assert_equal :debug, Blok::Logging::LogLevel.parse("debug")
  end

  def test_log_level_priority
    assert Blok::Logging::LogLevel.priority(:debug) <
           Blok::Logging::LogLevel.priority(:info)
    assert Blok::Logging::LogLevel.priority(:info) <
           Blok::Logging::LogLevel.priority(:warn)
    assert Blok::Logging::LogLevel.priority(:warn) <
           Blok::Logging::LogLevel.priority(:error)
  end
end
