import type Workflows from "./runner/types/Workflows.js";
import countriesFactsHelper from "./workflows/countries-cats-helper.js";
import countriesHelper from "./workflows/countries-helper.js";
import empty from "./workflows/empty.js";
import evalRetrieve from "./workflows/eval/eval-retrieve.js";
import evalRun from "./workflows/eval/eval-run.js";
import foreignAuth from "./workflows/eval/foreign-auth.js";

const workflows: Workflows = {
	"countries-helper": countriesHelper,
	"countries-cats-helper": countriesFactsHelper,
	"empty-helper": empty,
	"eval-run": evalRun,
	"eval-retrieve": evalRetrieve,
	"foreign-auth": foreignAuth,
};

export default workflows;
