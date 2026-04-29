/**
 * The Blok wordmark icon — sliced from `docs/assets/logo/dark.svg`
 * (paths 1–3, the icon-only portion). Brand color is fixed to the
 * official `#2BCD71` green; the wordmark text is intentionally NOT
 * embedded here so the component composes with arbitrary lockups
 * (sidebar header, command palette, error pages, future about box).
 *
 * Use:
 *   <BlokMark className="h-4 w-auto" />
 *
 * The viewBox is the icon's natural aspect ratio (40×32). The fill is
 * hard-coded to brand green — overrideable via `currentColor` is
 * intentionally NOT supported because the brand color is the brand,
 * not a parameter.
 */
type Props = {
	className?: string;
	title?: string;
};

export function BlokMark({ className, title = "Blok" }: Props) {
	return (
		<svg
			viewBox="0 0 40 32"
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			className={className}
			role="img"
			aria-label={title}
		>
			<path
				d="M4.58288 11.1045C4.86346 10.823 5.31836 10.823 5.59894 11.1045L9.97138 15.4904C10.252 15.7718 10.252 16.2282 9.97139 16.5096L5.59894 20.8955C5.31836 21.177 4.86346 21.177 4.58288 20.8955L0.210434 16.5096C-0.0701446 16.2282 -0.0701449 15.7718 0.210434 15.4904L4.58288 11.1045Z"
				fill="#2BCD71"
			/>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M20.7107 11.1972C20.2692 10.9492 19.7308 10.9492 19.2893 11.1972L15.9966 13.0468C15.5373 13.3048 15.2528 13.7917 15.2528 14.3198V17.6802C15.2528 18.2083 15.5373 18.6952 15.9966 18.9532L19.2893 20.8028C19.7308 21.0508 20.2692 21.0508 20.7107 20.8028L24.0034 18.9532C24.4627 18.6952 24.7472 18.2083 24.7472 17.6802V14.3198C24.7472 13.7917 24.4627 13.3048 24.0034 13.0468L20.7107 11.1972ZM29.0909 11.7486C29.0909 11.2205 28.8064 10.7336 28.3471 10.4756L20.7107 6.18602C20.2692 5.93799 19.7308 5.93799 19.2893 6.18602L11.6529 10.4756C11.1936 10.7336 10.9091 11.2205 10.9091 11.7486V20.2514C10.9091 20.7795 11.1936 21.2664 11.6529 21.5244L19.2893 25.814C19.7308 26.062 20.2692 26.062 20.7107 25.814L28.3471 21.5244C28.8064 21.2664 29.0909 20.7795 29.0909 20.2514V11.7486Z"
				fill="#2BCD71"
			/>
			<path
				d="M34.4011 11.1045C34.6816 10.823 35.1365 10.823 35.4171 11.1045L39.7896 15.4904C40.0701 15.7718 40.0701 16.2282 39.7896 16.5096L35.4171 20.8955C35.1365 21.177 34.6816 21.177 34.4011 20.8955L30.0286 16.5096C29.748 16.2282 29.748 15.7718 30.0286 15.4904L34.4011 11.1045Z"
				fill="#2BCD71"
			/>
		</svg>
	);
}
