import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { useState } from "react";
import { Upload, X, Star, StarOff, Plus } from "lucide-react";

export default function NotesMediaSection({ data, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const update = (field, value) => onChange({ ...data, [field]: value });

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    update("media_images", [...(data.media_images || []), file_url]);
    setUploading(false);
  };

  const handleVideoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingVideo(true);
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    update("media_videos", [...(data.media_videos || []), file_url]);
    setUploadingVideo(false);
  };

  const removeVideo = (index) => {
    update("media_videos", (data.media_videos || []).filter((_, i) => i !== index));
  };

  const removeImage = (index) => {
    update("media_images", (data.media_images || []).filter((_, i) => i !== index));
  };

  const addTag = () => {
    if (tagInput.trim() && !(data.tags || []).includes(tagInput.trim())) {
      update("tags", [...(data.tags || []), tagInput.trim()]);
      setTagInput("");
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Notes & Media</h3>

      <div>
        <Label className="text-xs text-muted-foreground">Notes</Label>
        <Textarea
          value={data.notes || ""}
          onChange={(e) => update("notes", e.target.value)}
          placeholder="Freeform session notes..."
          rows={4}
          className="mt-1"
        />
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">Images</Label>
        <div className="flex flex-wrap gap-2 mt-1">
          {(data.media_images || []).map((url, i) => (
            <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-border">
              <img src={url} alt="" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute top-0.5 right-0.5 bg-black/60 rounded-full p-0.5"
              >
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          ))}
          <label className="w-16 h-16 rounded-lg border-2 border-dashed border-border flex items-center justify-center cursor-pointer hover:border-primary/50">
            {uploading ? (
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            ) : (
              <Upload className="w-5 h-5 text-muted-foreground" />
            )}
            <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
          </label>
        </div>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">Videos (MP4)</Label>
        <div className="space-y-2 mt-1">
          {(data.media_videos || []).map((url, i) => (
            <div key={i} className="relative rounded-lg overflow-hidden border border-border bg-black">
              <video src={url} controls className="w-full max-h-40 rounded-lg" />
              <button
                type="button"
                onClick={() => removeVideo(i)}
                className="absolute top-1 right-1 bg-black/60 rounded-full p-1"
              >
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          ))}
          <label className="flex items-center gap-2 cursor-pointer border-2 border-dashed border-border rounded-lg px-3 py-2 hover:border-primary/50">
            {uploadingVideo ? (
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            ) : (
              <Upload className="w-4 h-4 text-muted-foreground" />
            )}
            <span className="text-xs text-muted-foreground">{uploadingVideo ? "Uploading..." : "Upload MP4 (max 50MB)"}</span>
            <input type="file" accept="video/mp4" className="hidden" onChange={handleVideoUpload} />
          </label>
        </div>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">Video Link (URL)</Label>
        <Input
          value={data.video_link || ""}
          onChange={(e) => update("video_link", e.target.value)}
          placeholder="https://..."
          className="h-12 mt-1"
        />
      </div>

      <div>
        <Label className="text-xs text-muted-foreground mb-2 block">Tags</Label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(data.tags || []).map((tag) => (
            <Badge key={tag} variant="outline" className="gap-1 py-1">
              {tag}
              <button type="button" onClick={() => update("tags", data.tags.filter((t) => t !== tag))}>
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            placeholder="Add tag..."
            className="h-10"
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())}
          />
          <Button type="button" size="sm" variant="outline" onClick={addTag} className="h-10">
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between py-2">
        <Label className="text-sm">Favorite Session</Label>
        <button type="button" onClick={() => update("is_favorite", !data.is_favorite)}>
          {data.is_favorite ? (
            <Star className="w-6 h-6 text-yellow-500 fill-yellow-500" />
          ) : (
            <StarOff className="w-6 h-6 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}