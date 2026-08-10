# frozen_string_literal: true

require_relative "../test_helper"

require "tmpdir"
require "blok/server/grpc_server"

# ADR 0014 — claim-check ($blokBlob) resolution.
#
# The runner replaces oversized +inputs+ with a sentinel; we read it back.
# These cover the trust boundary: the id arrives over the wire, so anything
# that could escape BLOK_BLOB_DIR must be refused before we open a file.
class BlobClaimCheckTest < Minitest::Test
  DecodeError = Blok::Server::BlokNodeRuntimeService::DecodeError

  def setup
    @dir = Dir.mktmpdir("blok-blob-")
    @previous = ENV["BLOK_BLOB_DIR"]
    ENV["BLOK_BLOB_DIR"] = @dir
    @service = Blok::Server::BlokNodeRuntimeService.new(
      Blok::Node::NodeRegistry.new("1.0.0-test"), sdk_version: "1.0.0-test"
    )
  end

  def teardown
    ENV["BLOK_BLOB_DIR"] = @previous
    FileUtils.remove_entry(@dir) if File.directory?(@dir)
  end

  def write_blob(run_id, payload)
    run_dir = File.join(@dir, run_id)
    FileUtils.mkdir_p(run_dir)
    json = JSON.generate(payload)
    File.write(File.join(run_dir, "blob.json"), json)
    { "$blokBlob" => { "id" => "#{run_id}/blob.json", "bytes" => json.bytesize, "codec" => "json" } }
  end

  def resolve(inputs)
    @service.send(:resolve_input_blob, inputs)
  end

  def test_resolves_sentinel_to_the_referenced_payload
    payload = { "symbols" => %w[a b] }
    assert_equal payload, resolve(write_blob("run_1", payload))
  end

  def test_end_to_end_through_decode_execute_request
    payload = { "big" => "x" * 4096 }
    ref = write_blob("run_2", payload)

    req = Blok::Runtime::V1::ExecuteRequest.new(
      node: Blok::Runtime::V1::NodeRef.new(name: "echo", type: "runtime.ruby"),
      inputs: JSON.generate(ref)
    )

    decoded = @service.send(:decode_execute_request, req)
    assert_equal payload["big"], decoded.node.config["big"]
  end

  def test_ordinary_inputs_pass_through_untouched
    assert_equal({ "msg" => "ping" }, resolve({ "msg" => "ping" }))

    # A sentinel-shaped key alongside real fields is NOT a claim-check.
    mixed = { "$blokBlob" => { "id" => "a/b" }, "other" => 1 }
    assert_equal mixed, resolve(mixed)
  end

  def test_refuses_a_ref_when_blob_dir_is_not_configured
    ref = write_blob("run_3", { "a" => 1 })
    ENV.delete("BLOK_BLOB_DIR")

    error = assert_raises(DecodeError) { resolve(ref) }
    assert_includes error.message, "BLOK_BLOB_DIR"
  end

  def test_refuses_ids_that_could_escape_the_blob_dir
    ["../../etc/passwd", "run_1/../../etc/passwd", "/etc/passwd", "passwd", ".ssh/id_rsa", 42, nil].each do |id|
      error = assert_raises(DecodeError) do
        resolve({ "$blokBlob" => { "id" => id, "bytes" => 1, "codec" => "json" } })
      end
      assert_includes error.message, "invalid $blokBlob id", "id #{id.inspect} was not rejected"
    end
  end

  def test_reports_a_missing_blob_instead_of_crashing
    error = assert_raises(DecodeError) do
      resolve({ "$blokBlob" => { "id" => "run_x/gone.json", "bytes" => 1, "codec" => "json" } })
    end
    assert_includes error.message, "cannot read blob"
  end

  # The runner sends a claim-check ref ONLY to a runtime that says it can
  # resolve one, so this advertisement is the whole capability gate.
  def test_list_nodes_advertises_blob_capability_only_when_configured
    assert_equal ["blob-v1"], @service.list_nodes(nil, nil).capabilities.to_a

    ENV.delete("BLOK_BLOB_DIR")
    assert_equal [], @service.list_nodes(nil, nil).capabilities.to_a
  end
end
