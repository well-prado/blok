defmodule Blok.Schema do
  @moduledoc """
  Small, explicit schema DSL used by node input and output contracts.

  Field names become atoms only when they are compiled into an application.
  Wire keys remain binaries, so adversarial JSON can never grow the atom table.
  """

  defmodule ValidationError do
    defexception [:message, :issues]

    @type issue :: %{path: String.t(), code: String.t(), message: String.t()}

    def exception(issues) when is_list(issues) do
      %__MODULE__{issues: issues, message: "schema validation failed"}
    end
  end

  @type field_type :: :string | :integer | :number | :boolean | :array | :object | :map

  defmacro __using__(_opts) do
    quote do
      import Blok.Schema, only: [field: 2, field: 3]
      Module.register_attribute(__MODULE__, :blok_schema_fields, accumulate: true)
      @before_compile Blok.Schema
    end
  end

  defmacro field(name, type, opts \\ []) do
    unless is_atom(name) do
      raise ArgumentError, "schema field names must be compile-time atoms"
    end

    quote bind_quoted: [name: name, type: type, opts: opts] do
      Module.put_attribute(__MODULE__, :blok_schema_fields, {
        name,
        type,
        Keyword.get(opts, :required, false),
        Keyword.get(opts, :nullable, false),
        Keyword.fetch(opts, :default)
      })
    end
  end

  @doc false
  defmacro __before_compile__(env) do
    fields = env.module |> Module.get_attribute(:blok_schema_fields) |> Enum.reverse()

    quote do
      @doc false
      def __schema_fields__, do: unquote(Macro.escape(fields))

      defstruct unquote(
                  Enum.map(fields, fn {name, _type, _required, _nullable, default} ->
                    {name, if(default == :error, do: nil, else: elem(default, 1))}
                  end)
                )

      @doc false
      def __schema__, do: Blok.Schema.json_schema(__schema_fields__())

      @doc false
      def new(value), do: Blok.Schema.cast(__MODULE__, value)

      @doc false
      def cast(value), do: Blok.Schema.cast(__MODULE__, value)
    end
  end

  @spec json_schema(list()) :: map()
  def json_schema(fields) do
    {properties, required} =
      Enum.reduce(fields, {%{}, []}, fn {name, type, required?, nullable?, default},
                                        {props, req} ->
        property =
          %{"type" => json_type(type)}
          |> maybe_add_nullable(nullable?)
          |> maybe_add_default(default)

        next_required =
          if required? and default == :error, do: [Atom.to_string(name) | req], else: req

        {Map.put(props, Atom.to_string(name), property), next_required}
      end)

    %{
      "$schema" => "https://json-schema.org/draft/2020-12/schema",
      "type" => "object",
      "properties" => properties,
      "additionalProperties" => false
    }
    |> then(fn schema ->
      if required == [], do: schema, else: Map.put(schema, "required", Enum.reverse(required))
    end)
  end

  @doc false
  def cast(module, value) when is_map(value) do
    fields = module.__schema_fields__()

    unknown =
      value
      |> Map.keys()
      |> Enum.filter(fn key ->
        is_binary(key) and
          not Enum.any?(fields, fn {name, _, _, _, _} -> Atom.to_string(name) == key end)
      end)

    issues =
      Enum.flat_map(fields, fn {name, type, required?, nullable?, default} ->
        key = Atom.to_string(name)
        present? = Map.has_key?(value, key) or Map.has_key?(value, name)

        cond do
          not present? and default != :error ->
            []

          not present? and required? ->
            [issue("$.#{key}", "required", "field is required")]

          not present? ->
            []

          is_nil(field_value(value, key, name)) and nullable? ->
            []

          is_nil(field_value(value, key, name)) ->
            [issue("$.#{key}", "type", "field cannot be null")]

          valid_type?(field_value(value, key, name), type) ->
            []

          true ->
            [issue("$.#{key}", "type", "expected #{json_type(type)}")]
        end
      end)

    issues =
      Enum.map(unknown, &issue("$.#{&1}", "additional_property", "unknown field")) ++ issues

    if issues == [] do
      {:ok, struct_from_fields(module, fields, value)}
    else
      {:error, ValidationError.exception(issues)}
    end
  end

  def cast(_module, _value),
    do: {:error, ValidationError.exception([issue("$", "type", "expected object")])}

  @doc false
  def to_json(value) when is_struct(value) do
    value |> Map.from_struct() |> plain_map()
  end

  def to_json(value), do: plain_map(value)

  defp struct_from_fields(module, fields, value) do
    Enum.reduce(fields, struct(module), fn {name, _type, _required?, _nullable?, default}, acc ->
      key = Atom.to_string(name)

      field =
        if Map.has_key?(value, key),
          do: Map.get(value, key),
          else: Map.get(value, name, default_value(default))

      Map.put(acc, name, field)
    end)
  end

  defp default_value({:ok, value}), do: value
  defp default_value(:error), do: nil

  defp field_value(value, binary_key, atom_key),
    do: Map.get(value, binary_key, Map.get(value, atom_key))

  defp issue(path, code, message), do: %{path: path, code: code, message: message}

  defp valid_type?(value, :string), do: is_binary(value)
  defp valid_type?(value, :integer), do: is_integer(value)
  defp valid_type?(value, :number), do: is_number(value)
  defp valid_type?(value, :boolean), do: is_boolean(value)
  defp valid_type?(value, :array), do: is_list(value)
  defp valid_type?(value, type) when type in [:object, :map], do: is_map(value)
  defp valid_type?(_value, _type), do: false

  defp json_type(:map), do: "object"

  defp json_type(type) when type in [:string, :integer, :number, :boolean, :array, :object],
    do: Atom.to_string(type)

  defp json_type(_), do: "object"

  defp maybe_add_nullable(schema, true), do: Map.put(schema, "type", [schema["type"], "null"])
  defp maybe_add_nullable(schema, _), do: schema

  defp maybe_add_default(schema, {:ok, value}), do: Map.put(schema, "default", value)
  defp maybe_add_default(schema, :error), do: schema

  defp plain_map(%_{} = value), do: value |> Map.from_struct() |> plain_map()

  defp plain_map(value) when is_map(value),
    do:
      Map.new(value, fn {key, item} ->
        {if(is_atom(key), do: Atom.to_string(key), else: key), plain_map(item)}
      end)

  defp plain_map(value) when is_list(value), do: Enum.map(value, &plain_map/1)
  defp plain_map(value), do: value
end
