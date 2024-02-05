import type React from 'react';
import {useEffect} from 'react';
import {useBuffer} from './use-buffer';

export const useMediaBuffering = (
	element: React.RefObject<HTMLVideoElement | HTMLAudioElement>,
	shouldBuffer: boolean,
) => {
	const buffer = useBuffer();

	useEffect(() => {
		let cleanup: () => void;

		const {current} = element;
		if (!current) {
			return;
		}

		if (!shouldBuffer) {
			return;
		}

		const onWaiting = () => {
			const {unblock} = buffer.delayPlayback();
			const onCanPlay = () => {
				unblock();
			};

			current.addEventListener('canplay', onCanPlay, {
				once: true,
			});

			cleanup = () => {
				current.removeEventListener('canplay', onCanPlay);
			};
		};

		current.addEventListener('waiting', onWaiting);

		return () => {
			cleanup();
		};
	}, [buffer, element, shouldBuffer]);
};
