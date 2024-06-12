import type {LogLevel} from '@remotion/renderer';
import {RenderInternals} from '@remotion/renderer';
import {writeFileSync} from 'fs';
import {join} from 'path';
import type {LambdaPayload} from '../../defaults';
import {LambdaRoutines} from '../../defaults';
import {callLambdaWithStreaming} from '../../shared/call-lambda';
import type {OnMessage} from '../streaming/streaming';
import {getCurrentRegionInFunction} from './get-current-region';
import type {OverallProgressHelper} from './overall-render-progress';

type StreamRendererResponse =
	| {
			type: 'success';
	  }
	| {
			type: 'error';
			error: string;
			shouldRetry: boolean;
	  };

const streamRenderer = ({
	payload,
	functionName,
	outdir,
	overallProgress,
	files,
	logLevel,
}: {
	payload: LambdaPayload;
	functionName: string;
	outdir: string;
	overallProgress: OverallProgressHelper;
	files: string[];
	logLevel: LogLevel;
}) => {
	if (payload.type !== LambdaRoutines.renderer) {
		throw new Error('Expected renderer type');
	}

	return new Promise<StreamRendererResponse>((resolve) => {
		const receivedStreamingPayload: OnMessage = ({message}) => {
			if (message.type === 'lambda-invoked') {
				overallProgress.setLambdaInvoked(payload.chunk);
				return;
			}

			if (message.type === 'frames-rendered') {
				overallProgress.setFrames({
					index: payload.chunk,
					encoded: message.payload.encoded,
					rendered: message.payload.rendered,
				});
				return;
			}

			if (message.type === 'video-chunk-rendered') {
				const filename = join(
					outdir,
					`chunk:${String(payload.chunk).padStart(8, '0')}:video`,
				);
				writeFileSync(filename, message.payload);
				files.push(filename);
				RenderInternals.Log.verbose(
					{indent: false, logLevel},
					`Received video chunk for chunk ${payload.chunk}`,
				);

				return;
			}

			if (message.type === 'audio-chunk-rendered') {
				const filename = join(
					outdir,
					`chunk:${String(payload.chunk).padStart(8, '0')}:audio`,
				);

				writeFileSync(filename, message.payload);
				RenderInternals.Log.verbose(
					{indent: false, logLevel},
					`Received audio chunk for chunk ${payload.chunk}`,
				);
				files.push(filename);
				return;
			}

			if (message.type === 'chunk-complete') {
				RenderInternals.Log.verbose(
					{indent: false, logLevel},
					`Finished chunk ${payload.chunk}`,
				);
				overallProgress.addChunkCompleted(
					payload.chunk,
					message.payload.start,
					message.payload.rendered,
				);
				return;
			}

			if (message.type === 'error-occurred') {
				overallProgress.addErrorWithoutUpload(message.payload.errorInfo);
				overallProgress.setFrames({
					encoded: 0,
					index: payload.chunk,
					rendered: 0,
				});

				RenderInternals.Log.error(
					{
						indent: false,
						logLevel,
					},
					`Renderer function of chunk ${payload.chunk} failed with error: ${message.payload.error}`,
				);
				RenderInternals.Log.error(
					{
						indent: false,
						logLevel,
					},
					`Will retry chunk = ${message.payload.shouldRetry}`,
				);

				resolve({
					type: 'error',
					error: message.payload.error,
					shouldRetry: message.payload.shouldRetry,
				});
				return;
			}

			throw new Error(`Unknown message type ${message.type}`);
		};

		callLambdaWithStreaming({
			functionName,
			payload,
			retriesRemaining: 2,
			region: getCurrentRegionInFunction(),
			timeoutInTest: 12000,
			type: LambdaRoutines.renderer,
			receivedStreamingPayload,
		})
			.then(() => {
				resolve({
					type: 'success',
				});
			})
			.catch((err) => {
				resolve({
					type: 'error',
					error: (err as Error).stack as string,
					shouldRetry: false,
				});
			});
	});
};

export const streamRendererFunctionWithRetry = async ({
	payload,
	files,
	functionName,
	outdir,
	overallProgress,
	logLevel,
}: {
	payload: LambdaPayload;
	functionName: string;
	outdir: string;
	overallProgress: OverallProgressHelper;
	files: string[];
	logLevel: LogLevel;
}): Promise<unknown> => {
	if (payload.type !== LambdaRoutines.renderer) {
		throw new Error('Expected renderer type');
	}

	const result = await streamRenderer({
		files,
		functionName,
		outdir,
		overallProgress,
		payload,
		logLevel,
	});

	if (result.type === 'error') {
		if (!result.shouldRetry) {
			throw result.error;
		}

		overallProgress.addRetry({
			attempt: payload.attempt + 1,
			time: Date.now(),
			chunk: payload.chunk,
		});

		return streamRendererFunctionWithRetry({
			files,
			functionName,
			outdir,
			overallProgress,
			payload: {
				...payload,
				attempt: payload.attempt + 1,
				retriesLeft: payload.retriesLeft - 1,
			},
			logLevel,
		});
	}
};
