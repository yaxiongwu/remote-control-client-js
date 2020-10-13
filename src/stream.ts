interface VideoResolutions {
  [name: string]: { width: { ideal: number }; height: { ideal: number } };
}

export const VideoResolutions: VideoResolutions = {
  qvga: { width: { ideal: 320 }, height: { ideal: 180 } },
  vga: { width: { ideal: 640 }, height: { ideal: 360 } },
  shd: { width: { ideal: 960 }, height: { ideal: 540 } },
  hd: { width: { ideal: 1280 }, height: { ideal: 720 } },
  fhd: { width: { ideal: 1920 }, height: { ideal: 1080 } },
  qhd: { width: { ideal: 2560 }, height: { ideal: 1440 } },
};

type Layer = 'none' | 'low' | 'medium' | 'high';

export interface Encoding {
  layer: Layer;
  maxBitrate: number;
  maxFramerate: number;
}

export interface Constraints extends MediaStreamConstraints {
  resolution: string;
  codec: string;
  simulcast: boolean;
  encodings?: Encoding[];
}

const defaults = {
  codec: 'VP8',
  resolution: 'hd',
  audio: true,
  video: true,
  simulcast: false,
};

export class LocalStream extends MediaStream {
  pc?: RTCPeerConnection;

  static async getUserMedia(constraints: Constraints = defaults) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: LocalStream.computeAudioConstraints(constraints),
      video: LocalStream.computeVideoConstraints(constraints),
    });
    return new LocalStream(stream, constraints);
  }

  static async getDisplayMedia(
    constraints: Constraints = {
      codec: 'VP8',
      resolution: 'hd',
      audio: false,
      video: true,
      simulcast: false,
    },
  ) {
    // @ts-ignore
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
    });

    return new LocalStream(stream, constraints);
  }

  constraints: Constraints;
  constructor(stream: MediaStream, constraints: Constraints) {
    super(stream);
    this.constraints = constraints;
    Object.setPrototypeOf(this, LocalStream.prototype);
  }

  private static computeAudioConstraints(constraints: Constraints): MediaTrackConstraints {
    return !!constraints.audio as MediaTrackConstraints;
  }

  private static computeVideoConstraints(constraints: Constraints): MediaTrackConstraints {
    if (constraints.video instanceof Object) {
      return constraints.video;
    } else if (constraints.resolution) {
      return {
        ...VideoResolutions[constraints.resolution],
      };
    }
    return !!constraints.video as MediaTrackConstraints;
  }

  private async getTrack(kind: 'audio' | 'video') {
    const stream = await navigator.mediaDevices.getUserMedia({
      [kind]:
        kind === 'video'
          ? LocalStream.computeVideoConstraints(this.constraints)
          : LocalStream.computeAudioConstraints(this.constraints),
    });
    return stream.getTracks()[0];
  }

  private publishTrack(track: MediaStreamTrack) {
    if (this.pc) {
      if (track.kind === 'video' && this.constraints.simulcast) {
        const encodings: RTCRtpEncodingParameters[] = [
          {
            rid: 'f',
          },
          {
            rid: 'h',
            scaleResolutionDownBy: 2.0,
            maxBitrate: 150000,
          },
          {
            rid: 'q',
            scaleResolutionDownBy: 4.0,
            maxBitrate: 100000,
          },
        ];

        if (this.constraints.encodings) {
          this.constraints.encodings.forEach((encoding) => {
            switch (encoding.layer) {
              case 'high':
                if (encoding.maxBitrate) {
                  encodings[0].maxBitrate = encoding.maxBitrate;
                }

                if (encoding.maxFramerate) {
                  encodings[0].maxFramerate = encoding.maxFramerate;
                }
                break;
              case 'medium':
                if (encoding.maxBitrate) {
                  encodings[1].maxBitrate = encoding.maxBitrate;
                }

                if (encoding.maxFramerate) {
                  encodings[1].maxFramerate = encoding.maxFramerate;
                }
                break;
              case 'low':
                if (encoding.maxBitrate) {
                  encodings[2].maxBitrate = encoding.maxBitrate;
                }

                if (encoding.maxFramerate) {
                  encodings[2].maxFramerate = encoding.maxFramerate;
                }
                break;
            }
          });
        }

        this.pc.addTransceiver(track, {
          streams: [this],
          direction: 'sendrecv',
          sendEncodings: encodings,
        });
      } else {
        this.pc.addTrack(track, this);
      }
    }
  }

  publish(pc: RTCPeerConnection) {
    this.pc = pc;
    this.getTracks().forEach(this.publishTrack.bind(this));
  }

  async switchDevice(kind: 'audio' | 'video', deviceId: string) {
    this.constraints = {
      ...this.constraints,
      [kind]:
        this.constraints[kind] instanceof Object
          ? {
              ...(this.constraints[kind] as object),
              deviceId,
            }
          : { deviceId },
    };
    const track = await this.getTrack(kind);

    let prev: MediaStreamTrack;
    if (kind === 'audio') {
      prev = this.getAudioTracks()[0];
    } else if (kind === 'video') {
      prev = this.getVideoTracks()[0];
    }
    this.addTrack(track);
    this.removeTrack(prev!);
    prev!.stop();

    // If published, replace published track with track from new device
    if (this.pc) {
      this.pc.getSenders().forEach(async (sender: RTCRtpSender) => {
        if (sender?.track?.kind === track.kind) {
          sender.track?.stop();
          sender.replaceTrack(track);
        }
      });
    }
  }

  mute(kind: 'audio' | 'video') {
    let track = this.getAudioTracks()[0];
    if (kind === 'video') {
      track = this.getVideoTracks()[0];
    }

    this.removeTrack(track);

    // If published, remove the track from the peer connection
    if (this.pc) {
      this.pc.getSenders().forEach(async (sender: RTCRtpSender) => {
        if (sender?.track === track) {
          this.pc!.removeTrack(sender);
        }
      });
    }
  }

  async unmute(kind: 'audio' | 'video') {
    const track = await this.getTrack(kind);
    this.addTrack(track);
    if (this.pc) {
      this.publishTrack(track);
    }
  }

  close() {
    if (this.pc) {
      this.pc.getSenders().forEach(async (sender: RTCRtpSender) => this.pc!.removeTrack(sender));
    }
  }
}

export interface RemoteStream extends MediaStream {
  api: RTCDataChannel;
  audio: boolean;
  video: Layer;
  _videoPreMute: Layer;

  preferLayer(layer: Layer): void;
  mute(kind: 'audio' | 'video'): void;
  unmute(kind: 'audio' | 'video'): void;
}

export function makeRemote(stream: MediaStream, api: RTCDataChannel): RemoteStream {
  const remote = stream as RemoteStream;
  remote.audio = true;
  remote.video = 'none';
  remote._videoPreMute = 'high';

  const select = () => {
    const call = {
      streamId: remote.id,
      video: remote.video,
      audio: remote.audio,
    };
    api.send(JSON.stringify(call));
  };

  remote.preferLayer = (layer: Layer) => {
    remote.video = layer;
    select();
  };

  remote.mute = (kind: 'audio' | 'video') => {
    if (kind === 'audio') {
      remote.audio = false;
    } else if (kind === 'video') {
      remote._videoPreMute = remote.video;
      remote.video = 'none';
    }
    select();
  };

  remote.unmute = (kind: 'audio' | 'video') => {
    if (kind === 'audio') {
      remote.audio = true;
    } else if (kind === 'video') {
      remote.video = remote._videoPreMute;
    }
    select();
  };

  return remote;
}
