import { useState } from "react";
import { Plus, X, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAddTags, useRemoveTag } from "@/hooks/useMetrics";

interface TagEditorProps {
  runId: string;
  tags: string[];
}

export function TagEditor({ runId, tags }: TagEditorProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const addTags = useAddTags(runId);
  const removeTag = useRemoveTag(runId);

  const handleAdd = () => {
    const newTag = inputValue.trim();
    if (!newTag || tags.includes(newTag)) {
      setInputValue("");
      return;
    }
    addTags.mutate([newTag], {
      onSuccess: () => {
        setInputValue("");
        setIsAdding(false);
      },
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    } else if (e.key === "Escape") {
      setIsAdding(false);
      setInputValue("");
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Tag className="w-3 h-3 text-zinc-600 shrink-0" />
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400 group"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag.mutate(tag)}
            className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-zinc-200"
            title={`Remove tag "${tag}"`}
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      {isAdding ? (
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (!inputValue.trim()) {
              setIsAdding(false);
            }
          }}
          placeholder="tag name"
          className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 outline-none focus:border-blue-500 w-20"
          autoFocus
        />
      ) : (
        <button
          type="button"
          onClick={() => setIsAdding(true)}
          className={cn(
            "inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded",
            "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors",
          )}
          title="Add tag"
        >
          <Plus className="w-2.5 h-2.5" />
          tag
        </button>
      )}
    </div>
  );
}
