import type Workflows from "./runner/types/Workflows";
import countriesFactsHelper from "./workflows/countries-cats-helper";
import countriesHelper from "./workflows/countries-helper";
import empty from "./workflows/empty";
import evalRetrieve from "./workflows/eval/eval-retrieve";
import evalRun from "./workflows/eval/eval-run";
import foreignAuth from "./workflows/eval/foreign-auth";

const workflows: Workflows = {
	"countries-helper": countriesHelper,
	"countries-cats-helper": countriesFactsHelper,
	"empty-helper": empty,
	"eval-run": evalRun,
	"eval-retrieve": evalRetrieve,
	"foreign-auth": foreignAuth,
};

export default workflows;
