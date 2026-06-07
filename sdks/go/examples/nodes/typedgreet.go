package nodes

import (
	"strings"

	blok "github.com/nickincloud/blok-go"
)

// TypedGreetInput / TypedGreetOutput demonstrate the SPEC-B typed node
// contract: config is validated into TypedGreetInput before the node runs,
// and both schemas are reflected for the catalog.
type TypedGreetInput struct {
	Name   string `json:"name"`
	Repeat int    `json:"repeat"`
}

type TypedGreetOutput struct {
	Greeting string `json:"greeting"`
	Length   int    `json:"length"`
}

// TypedGreetNodeName is the registered node name.
const TypedGreetNodeName = "typed-greet"

// TypedGreetNode is built with DefineNode (SPEC-B P4).
var TypedGreetNode = blok.DefineNode(TypedGreetNodeName, "Typed greeting (SPEC-B contract demo)",
	func(_ *blok.Context, in TypedGreetInput) (TypedGreetOutput, error) {
		repeat := in.Repeat
		if repeat <= 0 {
			repeat = 1
		}
		greeting := strings.Repeat("Hello, "+in.Name, repeat)
		return TypedGreetOutput{Greeting: greeting, Length: len(greeting)}, nil
	})
