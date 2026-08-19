import React from "react";
export function Test() {
	return (
		<div>
			<input aria-expanded="true" aria-controls="list" aria-activedescendant="item" />
			<ul id="list">
				<li id="item" aria-selected="true" onMouseDown={() => {}} onKeyDown={() => {}}>
					Test
				</li>
			</ul>
		</div>
	);
}
