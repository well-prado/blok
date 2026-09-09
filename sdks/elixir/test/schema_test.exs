defmodule Blok.SchemaTest do
  use ExUnit.Case, async: true

  defmodule Input do
    use Blok.Schema
    field :name, :string, required: true
    field :count, :integer, default: 1
  end

  test "casts JSON-keyed input into a typed struct and reflects JSON Schema" do
    assert {:ok, %Input{name: "Ada", count: 1}} = Input.cast(%{"name" => "Ada"})
    schema = Input.__schema__()
    assert schema["additionalProperties"] == false
    assert schema["properties"]["name"]["type"] == "string"
    assert schema["required"] == ["name"]
  end

  test "reports stable validation paths and refuses unknown wire keys" do
    assert {:error, error} = Input.cast(%{"extra" => true})
    assert Enum.any?(error.issues, &(&1.path == "$.name" and &1.code == "required"))
    assert Enum.any?(error.issues, &(&1.path == "$.extra" and &1.code == "additional_property"))
  end

  test "does not atomize untrusted keys" do
    before = :erlang.system_info(:atom_count)
    assert {:error, _} = Input.cast(%{"new_untrusted_key_943" => 1})
    assert :erlang.system_info(:atom_count) == before
  end
end
