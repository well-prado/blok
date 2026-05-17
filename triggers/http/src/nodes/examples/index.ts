import Base64ToPDF from "./base64-pdf";
import ChatUI from "./chat-ui";
import ArrayMapNode from "./dashboard-generator/ArrayMap";
import DashboardChartsGenerator from "./dashboard-generator/DashboardChartsGenerator";
import MemoryStorage from "./dashboard-generator/MemoryStorage";
import MultipleQueryGeneratorNode from "./dashboard-generator/MultipleQueryGeneratorNode";
import DashboardGeneratorUI from "./dashboard-generator/ui";
import MapperNode from "./db-manager/MapperNode";
import QueryGeneratorNode from "./db-manager/QueryGeneratorNode";
import DatabaseUI from "./db-manager/ui";
import FeedbackUI from "./feedback-ui";
import ImageCaptureUI from "./image-capture";
import MastraAgent from "./mastra-agent";
import WeatherUI from "./mastra-agent/ui";
import MongoQuery from "./mongodb-query";
import PostgresQuery from "./postgres-query";
import SaveImageBase64 from "./save-base64-image";
import DirectoryManager from "./workflow-docs/DirectoryManager";
import ErrorNode from "./workflow-docs/ErrorNode";
import FileManager from "./workflow-docs/FileManager";
import OpenAI from "./workflow-docs/OpenAI";
import WorkflowUI from "./workflow-docs/ui";

const ExampleNodes = {
	"directory-manager": DirectoryManager,
	openai: OpenAI,
	error: ErrorNode,
	"file-manager": FileManager,
	"workflow-ui": WorkflowUI,
	"database-ui": DatabaseUI,
	"postgres-query": PostgresQuery,
	"query-generator": QueryGeneratorNode,
	mapper: MapperNode,
	"dashboard-ui": DashboardGeneratorUI,
	"multiple-query-generator": MultipleQueryGeneratorNode,
	"array-map": ArrayMapNode,
	"dashboard-charts-generator": DashboardChartsGenerator,
	"memory-storage": MemoryStorage,
	"weather-ui": WeatherUI,
	"mastra-agent": MastraAgent,
	"mongodb-query": MongoQuery,
	"feedback-ui": FeedbackUI,
	"base64-pdf": Base64ToPDF,
	"save-image": SaveImageBase64,
	"image-capture-ui": ImageCaptureUI,
	"chat-ui": ChatUI,
};

export default ExampleNodes;
