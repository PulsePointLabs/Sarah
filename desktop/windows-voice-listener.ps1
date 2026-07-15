$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-VoiceEvent {
  param(
    [string]$Type,
    [hashtable]$Data = @{}
  )
  $payload = [ordered]@{
    type = $Type
    at = [DateTime]::UtcNow.ToString("o")
  }
  foreach ($key in $Data.Keys) {
    $payload[$key] = $Data[$key]
  }
  [Console]::WriteLine(($payload | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Speech
  $culture = [System.Globalization.CultureInfo]::GetCultureInfo("en-US")
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($culture)
  $engine.SetInputToDefaultAudioDevice()
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(4)
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(2)
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(700)
  $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(1000)

  $phrases = @(
    "Sarah",
    "end",
    "stop listening",
    "end listening",
    "undo last",
    "mark pre climax",
    "mark climax",
    "mark recovery",
    "Sarah emergency stop",
    "Sarah stop Howl",
    "Sarah mute Howl",
    "Sarah power up",
    "Sarah power down",
    "Sarah channel A up",
    "Sarah channel A down",
    "Sarah channel B up",
    "Sarah channel B down",
    "Sarah switch to milkmaster mode",
    "Sarah switch to simplex mode",
    "Sarah switch to vibrator mode",
    "Sarah set Howl intensity to ten",
    "Sarah set Howl intensity to fifteen"
  )

  $choices = [System.Speech.Recognition.Choices]::new()
  $choices.Add($phrases)
  $builder = [System.Speech.Recognition.GrammarBuilder]::new()
  $builder.Culture = $culture
  $builder.Append($choices)
  $commandGrammar = [System.Speech.Recognition.Grammar]::new($builder)
  $commandGrammar.Name = "SarahCommands"
  $engine.LoadGrammar($commandGrammar)

  $dictation = [System.Speech.Recognition.DictationGrammar]::new()
  $dictation.Name = "SarahDictation"
  $engine.LoadGrammar($dictation)

  Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -Action {
    $result = $Event.SourceEventArgs.Result
    if (-not $result) { return }
    $text = [string]$result.Text
    if ([string]::IsNullOrWhiteSpace($text)) { return }
    $confidence = [Math]::Round([double]$result.Confidence, 3)
    if ($confidence -lt 0.35 -and $text -notmatch '(?i)sarah|climax|recovery|undo|howl|listening') {
      return
    }
    Write-VoiceEvent -Type "recognized" -Data @{
      transcript = $text
      confidence = $confidence
      grammar = [string]$result.Grammar.Name
    }
  } | Out-Null

  Register-ObjectEvent -InputObject $engine -EventName AudioStateChanged -Action {
    Write-VoiceEvent -Type "audio_state" -Data @{
      state = [string]$Event.SourceEventArgs.AudioState
    }
  } | Out-Null

  $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Write-VoiceEvent -Type "ready" -Data @{
    mode = "windows_speech"
  }

  while ($true) {
    Start-Sleep -Milliseconds 500
  }
} catch {
  Write-VoiceEvent -Type "error" -Data @{
    message = $_.Exception.Message
  }
  exit 1
}
