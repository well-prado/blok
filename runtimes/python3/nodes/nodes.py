from nodes.api_call.node import ApiCall
from nodes.sentiment.node import Sentiment
from nodes.generate_pdf.node import GeneratePDF
# from nodes.embed.node import EmbeddingClip
# from nodes.milvus.insert.node import StoreInMilvus
# from nodes.milvus.query.node import SearchInMilvus
# from nodes.image_description.node import GenerateCaption

# Test nodes for integration testing
from nodes.test_simple.node import TestSimple
from nodes.test_context.node import TestContext
from nodes.test_error.node import TestError

nodes = {
    "api_call": ApiCall(),
    "generate-sentiment": Sentiment(),
    "generate-pdf": GeneratePDF(),
    # Test nodes
    "test-simple": TestSimple(),
    "test-context": TestContext(),
    "test-error": TestError(),
}

def get_nodes():
    return nodes
