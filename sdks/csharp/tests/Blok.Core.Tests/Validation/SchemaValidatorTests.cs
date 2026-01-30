using System.Text.Json;
using FluentAssertions;
using Blok.Core.Validation;
using Xunit;

namespace Blok.Core.Tests.Validation;

public class SchemaValidatorTests
{
    private readonly SchemaValidator _validator = new();

    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void TypeValidation_StringShouldPass()
    {
        var errors = _validator.Validate(
            Parse("\"hello\""),
            Parse("{\"type\": \"string\"}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void TypeValidation_NumberShouldFail_WhenStringExpected()
    {
        var errors = _validator.Validate(
            Parse("42"),
            Parse("{\"type\": \"string\"}")
        );
        errors.Should().HaveCount(1);
        errors[0].Should().Contain("expected type \"string\"");
    }

    [Fact]
    public void TypeValidation_NumberShouldPass()
    {
        var errors = _validator.Validate(
            Parse("42"),
            Parse("{\"type\": \"number\"}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void TypeValidation_BooleanShouldPass()
    {
        var errors = _validator.Validate(
            Parse("true"),
            Parse("{\"type\": \"boolean\"}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void TypeValidation_ObjectShouldPass()
    {
        var errors = _validator.Validate(
            Parse("{}"),
            Parse("{\"type\": \"object\"}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void TypeValidation_ArrayShouldPass()
    {
        var errors = _validator.Validate(
            Parse("[]"),
            Parse("{\"type\": \"array\"}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void TypeValidation_NullShouldPass()
    {
        var errors = _validator.Validate(
            Parse("null"),
            Parse("{\"type\": \"null\"}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void RequiredFields_ShouldPass_WhenAllPresent()
    {
        var errors = _validator.Validate(
            Parse("{\"name\": \"John\", \"email\": \"john@example.com\"}"),
            Parse("{\"type\": \"object\", \"required\": [\"name\", \"email\"]}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void RequiredFields_ShouldFail_WhenMissing()
    {
        var errors = _validator.Validate(
            Parse("{\"name\": \"John\"}"),
            Parse("{\"type\": \"object\", \"required\": [\"name\", \"email\"]}")
        );
        errors.Should().HaveCount(1);
        errors[0].Should().Contain("email");
    }

    [Fact]
    public void StringConstraints_ShouldPass_WhenInRange()
    {
        var errors = _validator.Validate(
            Parse("\"hello\""),
            Parse("{\"type\": \"string\", \"minLength\": 2, \"maxLength\": 10}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void StringConstraints_ShouldFail_WhenTooShort()
    {
        var errors = _validator.Validate(
            Parse("\"x\""),
            Parse("{\"type\": \"string\", \"minLength\": 2, \"maxLength\": 10}")
        );
        errors.Should().HaveCount(1);
        errors[0].Should().Contain("less than minimum");
    }

    [Fact]
    public void StringConstraints_ShouldFail_WhenTooLong()
    {
        var errors = _validator.Validate(
            Parse("\"this is way too long\""),
            Parse("{\"type\": \"string\", \"minLength\": 2, \"maxLength\": 10}")
        );
        errors.Should().HaveCount(1);
        errors[0].Should().Contain("exceeds maximum");
    }

    [Fact]
    public void NumericConstraints_ShouldPass_WhenInRange()
    {
        var errors = _validator.Validate(
            Parse("50"),
            Parse("{\"type\": \"number\", \"minimum\": 0, \"maximum\": 100}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void NumericConstraints_ShouldFail_WhenBelowMinimum()
    {
        var errors = _validator.Validate(
            Parse("-1"),
            Parse("{\"type\": \"number\", \"minimum\": 0, \"maximum\": 100}")
        );
        errors.Should().HaveCount(1);
        errors[0].Should().Contain("less than minimum");
    }

    [Fact]
    public void NumericConstraints_ShouldFail_WhenAboveMaximum()
    {
        var errors = _validator.Validate(
            Parse("101"),
            Parse("{\"type\": \"number\", \"minimum\": 0, \"maximum\": 100}")
        );
        errors.Should().HaveCount(1);
        errors[0].Should().Contain("exceeds maximum");
    }

    [Fact]
    public void EnumValidation_ShouldPass_WhenValueInEnum()
    {
        var errors = _validator.Validate(
            Parse("\"red\""),
            Parse("{\"type\": \"string\", \"enum\": [\"red\", \"green\", \"blue\"]}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void EnumValidation_ShouldFail_WhenValueNotInEnum()
    {
        var errors = _validator.Validate(
            Parse("\"yellow\""),
            Parse("{\"type\": \"string\", \"enum\": [\"red\", \"green\", \"blue\"]}")
        );
        errors.Should().HaveCount(1);
        errors[0].Should().Contain("enum");
    }

    [Fact]
    public void NestedProperties_ShouldValidateRecursively()
    {
        var schema = Parse(@"{
            ""type"": ""object"",
            ""properties"": {
                ""user"": {
                    ""type"": ""object"",
                    ""required"": [""name""],
                    ""properties"": {
                        ""name"": { ""type"": ""string"" }
                    }
                }
            }
        }");

        var valid = Parse("{\"user\": {\"name\": \"John\"}}");
        _validator.Validate(valid, schema).Should().BeEmpty();

        var invalid = Parse("{\"user\": {}}");
        _validator.Validate(invalid, schema).Should().HaveCount(1);
    }

    [Fact]
    public void IntegerType_ShouldValidate()
    {
        var errors = _validator.Validate(
            Parse("42"),
            Parse("{\"type\": \"integer\"}")
        );
        errors.Should().BeEmpty();
    }

    [Fact]
    public void IntegerType_ShouldFail_ForFloat()
    {
        var errors = _validator.Validate(
            Parse("3.14"),
            Parse("{\"type\": \"integer\"}")
        );
        errors.Should().HaveCount(1);
    }
}
