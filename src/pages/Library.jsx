import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Pause, Download, Trash2, Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/PageHeader";

const formatDuration = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

export default function Library() {
  const queryClient = useQueryClient();
  const [playingId, setPlayingId] = useState(null);
  const [audioRef, setAudioRef] = useState(null);

  const { data: exports = [], isLoading } = useQuery({
    queryKey: ["audioExports"],
    queryFn: () => base44.entities.AudioExport.list(),
  });

  const deleteExport = useMutation({
    mutationFn: (id) => base44.entities.AudioExport.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["audioExports"] }),
  });

  const handlePlay = (export_) => {
    if (playingId === export_.id) {
      audioRef?.pause();
      setPlayingId(null);
    } else {
      if (audioRef) audioRef.pause();
      const audio = new Audio(export_.file_url);
      audio.onended = () => setPlayingId(null);
      audio.play();
      setAudioRef(audio);
      setPlayingId(export_.id);
    }
  };

  const handleDownload = (export_) => {
    const a = document.createElement("a");
    a.href = export_.file_url;
    a.download = `${export_.title}.wav`;
    a.click();
  };

  const handleDelete = (id) => {
    if (confirm("Delete this audio export?")) {
      deleteExport.mutate(id);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audio Library"
        subtitle="Manage your TTS exports and past downloads"
      />

      {exports.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Music className="w-12 h-12 text-muted-foreground mb-3 opacity-50" />
          <h3 className="text-lg font-semibold text-foreground mb-1">No audio exports yet</h3>
          <p className="text-sm text-muted-foreground">
            Export TTS audio from a session to add files to your library
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {exports.map((export_) => (
            <div
              key={export_.id}
              className="bg-card rounded-lg border border-border p-4 flex items-start justify-between hover:shadow-md transition-shadow"
            >
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-foreground truncate">{export_.title}</h3>
                {export_.section_name && (
                  <p className="text-xs text-muted-foreground">{export_.section_name}</p>
                )}
                {export_.notes && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{export_.notes}</p>
                )}
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                  {export_.duration_seconds && (
                    <span>{formatDuration(export_.duration_seconds)}</span>
                  )}
                  {export_.voice && <span>Voice: {export_.voice}</span>}
                  {export_.speed && <span>Speed: {export_.speed}x</span>}
                </div>
              </div>

              <div className="flex items-center gap-2 ml-4 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handlePlay(export_)}
                  className="text-primary hover:bg-primary/10"
                >
                  {playingId === export_.id ? (
                    <Pause className="w-4 h-4" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDownload(export_)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Download className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(export_.id)}
                  className="text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}