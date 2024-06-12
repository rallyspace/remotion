import type {AudioCodec, BrowserLog, Codec} from '@remotion/renderer';
import {RenderInternals} from '@remotion/renderer';
import fs from 'node:fs';
import path from 'node:path';
import {VERSION} from 'remotion/version';
import {decompressInputProps} from '../shared/compress-props';
import type {LambdaPayload} from '../shared/constants';
import {LambdaRoutines, RENDERER_PATH_TOKEN} from '../shared/constants';
import {isFlakyError} from '../shared/is-flaky-error';
import {truthy} from '../shared/truthy';
import {enableNodeIntrospection} from '../shared/why-is-node-running';
import type {ObjectChunkTimingData} from './chunk-optimization/types';
import {
	canConcatAudioSeamlessly,
	canConcatVideoSeamlessly,
} from './helpers/can-concat-seamlessly';
import {
	forgetBrowserEventLoop,
	getBrowserInstance,
} from './helpers/get-browser-instance';
import {executablePath} from './helpers/get-chromium-executable-path';
import {getCurrentRegionInFunction} from './helpers/get-current-region';
import {startLeakDetection} from './helpers/leak-detection';
import {onDownloadsHelper} from './helpers/on-downloads-logger';
import type {RequestContext} from './helpers/request-context';
import {timer} from './helpers/timer';
import {getTmpDirStateIfENoSp} from './helpers/write-lambda-error';
import type {OnStream} from './streaming/streaming';

type Options = {
	expectedBucketOwner: string;
	isWarm: boolean;
};

const renderHandler = async ({
	params,
	options,
	logs,
	onStream,
}: {
	params: LambdaPayload;
	options: Options;
	logs: BrowserLog[];
	onStream: OnStream;
}): Promise<{}> => {
	if (params.type !== LambdaRoutines.renderer) {
		throw new Error('Params must be renderer');
	}

	if (params.launchFunctionConfig.version !== VERSION) {
		throw new Error(
			`The version of the function that was specified as "rendererFunctionName" is ${VERSION} but the version of the function that invoked the render is ${params.launchFunctionConfig.version}. Please make sure that the version of the function that is specified as "rendererFunctionName" is the same as the version of the function that is invoked.`,
		);
	}

	const inputPropsPromise = decompressInputProps({
		bucketName: params.bucketName,
		expectedBucketOwner: options.expectedBucketOwner,
		region: getCurrentRegionInFunction(),
		serialized: params.inputProps,
		propsType: 'input-props',
	});

	const resolvedPropsPromise = decompressInputProps({
		bucketName: params.bucketName,
		expectedBucketOwner: options.expectedBucketOwner,
		region: getCurrentRegionInFunction(),
		serialized: params.resolvedProps,
		propsType: 'resolved-props',
	});

	const browserInstance = await getBrowserInstance(
		params.logLevel,
		false,
		params.chromiumOptions,
	);

	const outputPath = RenderInternals.tmpDir('remotion-render-');

	if (typeof params.chunk !== 'number') {
		throw new Error('must pass chunk');
	}

	if (!params.frameRange) {
		throw new Error('must pass framerange');
	}

	RenderInternals.Log.verbose(
		{indent: false, logLevel: params.logLevel},
		`Rendering frames ${params.frameRange[0]}-${params.frameRange[1]} in this Lambda function`,
	);

	const start = Date.now();
	const chunkTimingData: ObjectChunkTimingData = {
		timings: {},
		chunk: params.chunk,
		frameRange: params.frameRange,
		startDate: start,
	};

	const outdir = RenderInternals.tmpDir(RENDERER_PATH_TOKEN);

	const chunk = `localchunk-${String(params.chunk).padStart(8, '0')}`;
	const defaultAudioCodec = RenderInternals.getDefaultAudioCodec({
		codec: params.codec,
		preferLossless: params.preferLossless,
	});

	const seamlessAudio = canConcatAudioSeamlessly(
		defaultAudioCodec,
		params.framesPerLambda,
	);
	const seamlessVideo = canConcatVideoSeamlessly(params.codec);

	RenderInternals.Log.verbose(
		{indent: false, logLevel: params.logLevel},
		`Preparing for rendering a chunk. Audio = ${
			seamlessAudio ? 'seamless' : 'normal'
		}, Video = ${seamlessVideo ? 'seamless' : 'normal'}`,
		params.logLevel,
	);

	const chunkCodec: Codec =
		seamlessVideo && params.codec === 'h264' ? 'h264-ts' : params.codec;
	const audioCodec: AudioCodec | null =
		defaultAudioCodec === null
			? null
			: seamlessAudio
				? defaultAudioCodec
				: 'pcm-16';

	const videoExtension = RenderInternals.getFileExtensionFromCodec(
		chunkCodec,
		audioCodec,
	);
	const audioExtension = audioCodec
		? RenderInternals.getExtensionFromAudioCodec(audioCodec)
		: null;

	const videoOutputLocation = path.join(outdir, `${chunk}.${videoExtension}`);

	const willRenderAudioEval = RenderInternals.getShouldRenderAudio({
		assetsInfo: null,
		codec: params.codec,
		enforceAudioTrack: true,
		muted: params.muted,
	});

	if (willRenderAudioEval === 'maybe') {
		throw new Error('Cannot determine whether to render audio or not');
	}

	const audioOutputLocation =
		willRenderAudioEval === 'no'
			? null
			: RenderInternals.isAudioCodec(params.codec)
				? null
				: audioExtension
					? path.join(outdir, `${chunk}.${audioExtension}`)
					: null;

	const resolvedProps = await resolvedPropsPromise;
	const serializedInputPropsWithCustomSchema = await inputPropsPromise;

	const allFrames = RenderInternals.getFramesToRender(
		params.frameRange,
		params.everyNthFrame,
	);

	await new Promise<void>((resolve, reject) => {
		RenderInternals.internalRenderMedia({
			repro: false,
			composition: {
				id: params.composition,
				durationInFrames: params.durationInFrames,
				fps: params.fps,
				height: params.height,
				width: params.width,
				defaultCodec: null,
			},
			imageFormat: params.imageFormat,
			serializedInputPropsWithCustomSchema,
			frameRange: params.frameRange,
			onProgress: ({renderedFrames, encodedFrames, stitchStage}) => {
				RenderInternals.Log.verbose(
					{indent: false, logLevel: params.logLevel},
					`Rendered ${renderedFrames} frames, encoded ${encodedFrames} frames, stage = ${stitchStage}`,
				);

				const allFramesRendered = allFrames.length === renderedFrames;
				const allFramesEncoded = allFrames.length === encodedFrames;

				const frameReportPoint =
					(renderedFrames % params.progressEveryNthFrame === 0 ||
						allFramesRendered) &&
					!allFramesEncoded;
				const encodedFramesReportPoint =
					(encodedFrames % params.progressEveryNthFrame === 0 ||
						allFramesEncoded) &&
					allFramesRendered;

				if (frameReportPoint || encodedFramesReportPoint) {
					onStream({
						type: 'frames-rendered',
						payload: {rendered: renderedFrames, encoded: encodedFrames},
					});
				}

				if (renderedFrames === allFrames.length) {
					RenderInternals.Log.verbose(
						{indent: false, logLevel: params.logLevel},
						'Rendered all frames!',
					);
				}

				chunkTimingData.timings[renderedFrames] = Date.now() - start;
			},
			concurrency: params.concurrencyPerLambda,
			onStart: () => {
				onStream({
					type: 'lambda-invoked',
					payload: {
						attempt: params.attempt,
					},
				});
			},
			puppeteerInstance: browserInstance.instance,
			serveUrl: params.serveUrl,
			jpegQuality: params.jpegQuality ?? RenderInternals.DEFAULT_JPEG_QUALITY,
			envVariables: params.envVariables ?? {},
			logLevel: params.logLevel,
			onBrowserLog: (log) => {
				logs.push(log);
			},
			outputLocation: videoOutputLocation,
			codec: chunkCodec,
			crf: params.crf ?? null,
			pixelFormat: params.pixelFormat ?? RenderInternals.DEFAULT_PIXEL_FORMAT,
			proResProfile: params.proResProfile,
			x264Preset: params.x264Preset,
			onDownload: onDownloadsHelper(params.logLevel),
			overwrite: false,
			chromiumOptions: params.chromiumOptions,
			scale: params.scale,
			timeoutInMilliseconds: params.timeoutInMilliseconds,
			port: null,
			everyNthFrame: params.everyNthFrame,
			numberOfGifLoops: null,
			muted: params.muted,
			enforceAudioTrack: true,
			audioBitrate: params.audioBitrate,
			videoBitrate: params.videoBitrate,
			encodingBufferSize: params.encodingBufferSize,
			encodingMaxRate: params.encodingMaxRate,
			audioCodec,
			preferLossless: params.preferLossless,
			browserExecutable: executablePath(),
			cancelSignal: undefined,
			disallowParallelEncoding: false,
			ffmpegOverride: ({args}) => args,
			indent: false,
			onCtrlCExit: () => undefined,
			server: undefined,
			serializedResolvedPropsWithCustomSchema: resolvedProps,
			offthreadVideoCacheSizeInBytes: params.offthreadVideoCacheSizeInBytes,
			colorSpace: params.colorSpace,
			binariesDirectory: null,
			separateAudioTo: audioOutputLocation,
			forSeamlessAacConcatenation: seamlessAudio,
			compositionStart: params.compositionStart,
			onBrowserDownload: () => {
				throw new Error('Should not download a browser in Lambda');
			},
		})
			.then(({slowestFrames}) => {
				RenderInternals.Log.verbose(
					{indent: false, logLevel: params.logLevel},
					`Slowest frames:`,
				);
				slowestFrames.forEach(({frame, time}) => {
					RenderInternals.Log.verbose(
						{indent: false, logLevel: params.logLevel},
						`  Frame ${frame} (${time.toFixed(3)}ms)`,
					);
				});
				resolve();
			})
			.catch((err) => reject(err));
	});

	const streamTimer = timer(
		'Streaming chunk to the main function',
		params.logLevel,
	);

	let audioChunkRenderedPromise;
	if (audioOutputLocation) {
		const audioChunkTimer = timer('Sending audio chunk', params.logLevel);
		audioChunkRenderedPromise = onStream({
			type: 'audio-chunk-rendered',
			payload: fs.readFileSync(audioOutputLocation),
		})
			.then(() => {
				audioChunkTimer.end();
			})
			.catch((err) => {
				RenderInternals.Log.error(
					{indent: false, logLevel: params.logLevel},
					`Error occurred while streaming audio chunk to main function`,
				);
				RenderInternals.Log.error(
					{indent: false, logLevel: params.logLevel},
					err,
				);
				throw err;
			});
	}

	console.log(`chunk=${chunk}`, 'videoOutputLocation:', videoOutputLocation);
	let videoChunkRenderedPromise;
	if (videoOutputLocation) {
		const videoChunkTimer = timer('Sending main chunk', params.logLevel);

		let videoPayload;
		try {
		  videoPayload = fs.readFileSync(videoOutputLocation);
			console.log(`chunk=${chunk}`, 'video payload size', videoPayload?.length)
		} catch (e) {
		  console.log(`chunk=${chunk}`, 'Failed to read videoOutput', e);
		  throw e;
		}

		videoChunkRenderedPromise = onStream({
			type: RenderInternals.isAudioCodec(params.codec)
				? 'audio-chunk-rendered'
				: 'video-chunk-rendered',
			payload: videoPayload // fs.readFileSync(videoOutputLocation),
		})
			.then(() => {
				videoChunkTimer.end();
			})
			.catch((err) => {
				RenderInternals.Log.error(
					{indent: false, logLevel: params.logLevel},
					`Error occurred while streaming main chunk to main function`,
				);
				RenderInternals.Log.error(
					{indent: false, logLevel: params.logLevel},
					err,
				);
				throw err;
			});
	}

	const endRendered = Date.now();

	const chunkCompletePromise = onStream({
		type: 'chunk-complete',
		payload: {
			rendered: endRendered,
			start,
		},
	}).then(() => {
		streamTimer.end();
	}).catch(err => {

	RenderInternals.Log.error(
			{indent: false, logLevel: params.logLevel},
			`Error occurred while streaming chunk-complete to main function`,
		);
		RenderInternals.Log.error(
			{indent: false, logLevel: params.logLevel},
			err,
		);
	});

	RenderInternals.Log.verbose(
		{indent: false, logLevel: params.logLevel},
		'Cleaning up and writing timings',
	);

	await Promise.all(
		[
		  audioChunkRenderedPromise,
			videoChunkRenderedPromise,
			chunkCompletePromise,
			fs.promises.rm(videoOutputLocation, {recursive: true}),
			audioOutputLocation
				? fs.promises.rm(audioOutputLocation, {recursive: true})
				: null,
			fs.promises.rm(outputPath, {recursive: true}),
		].filter(truthy),
	);
	RenderInternals.Log.verbose(
		{indent: false, logLevel: params.logLevel},
		'Done!',
	);

	return {};
};

const ENABLE_SLOW_LEAK_DETECTION = false;

export const rendererHandler = async (
	params: LambdaPayload,
	options: Options,
	onStream: OnStream,
	requestContext: RequestContext,
): Promise<{
	type: 'success';
}> => {
	if (params.type !== LambdaRoutines.renderer) {
		throw new Error('Params must be renderer');
	}

	const logs: BrowserLog[] = [];

	const leakDetection = enableNodeIntrospection(ENABLE_SLOW_LEAK_DETECTION);

	try {
		await renderHandler({params, options, logs, onStream});
		return {
			type: 'success',
		};
	} catch (err) {
		if (process.env.NODE_ENV === 'test') {
			console.log({err});
			throw err;
		}

		// If this error is encountered, we can just retry as it
		// is a very rare error to occur
		const isRetryableError = isFlakyError(err as Error);

		const shouldNotRetry = (err as Error).name === 'CancelledError';

		const shouldRetry =
			isRetryableError && params.retriesLeft > 0 && !shouldNotRetry;

		RenderInternals.Log.error(
			{indent: false, logLevel: params.logLevel},
			`Error occurred (will retry = ${String(shouldRetry)})`,
		);
		RenderInternals.Log.error({indent: false, logLevel: params.logLevel}, err);

		onStream({
			type: 'error-occurred',
			payload: {
				error: (err as Error).stack as string,
				shouldRetry,
				errorInfo: {
					name: (err as Error).name as string,
					message: (err as Error).message as string,
					stack: (err as Error).stack as string,
					chunk: params.chunk,
					frame: null,
					type: 'renderer',
					isFatal: !shouldRetry,
					tmpDir: getTmpDirStateIfENoSp((err as Error).stack as string),
					attempt: params.attempt,
					totalAttempts: params.retriesLeft + params.attempt,
					willRetry: shouldRetry,
				},
			},
		});

		throw err;
	} finally {
		forgetBrowserEventLoop(params.logLevel);

		startLeakDetection(leakDetection, requestContext.awsRequestId);
	}
};
